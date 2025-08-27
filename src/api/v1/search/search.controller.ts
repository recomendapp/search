import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Controller from '../../../interfaces/controller.interface';
import typesenseClient from '../../../lib/typesense';
import { verifyApiKey } from '../../../utils/verifyApiKey';
import {
	UserSearchQuery,
	userSearchQuerySchema,
	userSearchResponseSchema,

	PlaylistSearchQuery,
	playlistSearchQuerySchema,
	playlistSearchResponseSchema,

	MovieSearchQuery,
	movieSearchQuerySchema,
	movieSearchResponseSchema,

	TvSeriesSearchQuery,
	tvSeriesSearchQuerySchema,
	tvSeriesSearchResponseSchema,

	PersonSearchQuery,
	personSearchQuerySchema,
	personSearchResponseSchema,
	AllSearchQuery,
	allSearchQuerySchema,
	allSearchResponseSchema,
	
} from '@recomendapp/types';
import { SearchParams } from 'typesense/lib/Typesense/Documents';
import { SupabaseClient } from '@supabase/supabase-js';
import { TypesenseSearchResult } from '../../../types/Typesense';

export default class SearchController implements Controller {
	public register(server: FastifyInstance, prefix = ''): void {
		const basePath = `${prefix}/search`;

		// ALL
		server.post<{ Querystring: AllSearchQuery }>(`${basePath}`, {
			onRequest: [verifyApiKey],
			schema: {
				querystring: allSearchQuerySchema,
				response: {
					200: allSearchResponseSchema,
				}
			}
		}, this.searchAll);

		// MOVIES
		server.post<{ Querystring: MovieSearchQuery }>(`${basePath}/movies`, {
			onRequest: [verifyApiKey],
			schema: {
				querystring: movieSearchQuerySchema,
				response: {
					200: movieSearchResponseSchema,
				}
			}
		}, this.searchMovies);

		// TV SERIES
		server.post<{ Querystring: TvSeriesSearchQuery }>(`${basePath}/tv-series`, {
			onRequest: [verifyApiKey],
			schema: {
				querystring: tvSeriesSearchQuerySchema,
				response: {
					200: tvSeriesSearchResponseSchema,
				}
			}
		}, this.searchTVSeries);

		// PERSONS
		server.post<{ Querystring: PersonSearchQuery }>(`${basePath}/persons`, {
			onRequest: [verifyApiKey],
			schema: {
				querystring: personSearchQuerySchema,
				response: {
					200: personSearchResponseSchema,
				}
			}
		}, this.searchPersons);

		// USERS
		server.post<{ Querystring: UserSearchQuery }>(`${basePath}/users`, {
			onRequest: [verifyApiKey],
			schema: {
				querystring: userSearchQuerySchema,
				response: {
					200: userSearchResponseSchema,
				}
			}
		}, this.searchUsers);

		// PLAYLISTS
		server.post<{ Querystring: PlaylistSearchQuery }>(`${basePath}/playlists`, {
			onRequest: [verifyApiKey],
			schema: {
				querystring: playlistSearchQuerySchema,
				response: {
					200: playlistSearchResponseSchema,
				}
			}
		}, this.searchPlaylists);
	}

	// ALL
	private searchAll = async (request: FastifyRequest<{ Querystring: AllSearchQuery }>, reply: FastifyReply) => {
		const { query } = request.query;
		const user = request.user as { sub: string } | undefined | null;
    	const userId = user?.sub;

		request.log.info(`Performing an all-encompassing search with query: "${query}"`);

		const resultsPerType = 5;

		try {
			const searches = [
				{ collection: 'movies', q: query, per_page: resultsPerType, query_by: 'original_title,titles' },
				{ collection: 'tv_series', q: query, per_page: resultsPerType, query_by: 'original_name,names' },
				{ collection: 'persons', q: query, per_page: resultsPerType, query_by: 'name,also_known_as' },
				{ collection: 'users', q: query, per_page: resultsPerType, query_by: 'username,full_name' },
				{ collection: 'playlists', q: query, per_page: resultsPerType, query_by: 'title,description', filter_by: this.getPlaylistPermissionFilter(userId) }
			];
			const multiSearchResult = await typesenseClient.multiSearch.perform({ searches: searches }, {});
			const { results } = multiSearchResult as { results: TypesenseSearchResult<{ id: string, popularity?: number, followers_count?: number, likes_count?: number }>[] };

        	const [moviesResult, tvSeriesResult, personsResult, usersResult, playlistsResult] = results;

			const movieIds = moviesResult.hits?.map(h => h.document.id) || [];
			const tvSeriesIds = tvSeriesResult.hits?.map(h => h.document.id) || [];
			const personIds = personsResult.hits?.map(h => h.document.id) || [];
			const userIds = usersResult.hits?.map(h => h.document.id) || [];
			const playlistIds = playlistsResult.hits?.map(h => h.document.id) || [];
			
			let bestResultMeta: { type: string; id: string; score: number } | null = null;
			const potentialBest = [
				{ type: 'movie', hit: moviesResult.hits?.[0] },
				{ type: 'tv_series', hit: tvSeriesResult.hits?.[0] },
				{ type: 'person', hit: personsResult.hits?.[0] },
				{ type: 'user', hit: usersResult.hits?.[0] },
				{ type: 'playlist', hit: playlistsResult.hits?.[0] },
			];
			const allHits = potentialBest.map(c => c.hit).filter(Boolean) as NonNullable<typeof potentialBest[0]['hit']>[];
			const maxTextScore = Math.max(...allHits.map(h => h.text_match || 0), 1);
			const maxPopularity = Math.max(...allHits.map(h => h.document.popularity || h.document.followers_count || h.document.likes_count || 0), 1);

			for (const candidate of potentialBest) {
				if (candidate.hit?.document) {
					const doc = candidate.hit.document;
					const textScore = candidate.hit.text_match || 0;
					const popularityMetric = doc.popularity || doc.followers_count || doc.likes_count || 0;

					const normalizedText = textScore / maxTextScore;
					const normalizedPop = popularityMetric / maxPopularity;

					const hybridScore = normalizedText * 0.9 + normalizedPop * 0.1;

					if (!bestResultMeta || hybridScore > bestResultMeta.score) {
						bestResultMeta = { type: candidate.type, id: doc.id, score: hybridScore };
					}
				}
			}

			const [
				hydratedMovies,
				hydratedTvSeries,
				hydratedPersons,
				hydratedUsers,
				hydratedPlaylists,
				hydratedBestResultData
			] = await Promise.all([
				this.hydrateByIds(request.supabaseClient, 'media_movie', movieIds),
				this.hydrateByIds(request.supabaseClient, 'media_tv_series', tvSeriesIds),
				this.hydrateByIds(request.supabaseClient, 'media_person', personIds),
				this.hydrateByIds(request.supabaseClient, 'user', userIds),
				this.hydrateByIds(request.supabaseClient, 'playlists', playlistIds),
				bestResultMeta ? this.hydrateByIds(request.supabaseClient, this.getTableNameForType(bestResultMeta.type), [bestResultMeta.id]) : Promise.resolve([])
			]);

			const bestResult = bestResultMeta && hydratedBestResultData[0]
				? { type: bestResultMeta.type, data: hydratedBestResultData[0] }
				: null;
			
			return {
				bestResult,
				movies: {
					data: hydratedMovies,
					pagination: {
						total_results: moviesResult.found,
						total_pages: Math.ceil(moviesResult.found / resultsPerType),
						current_page: 1,
						per_page: resultsPerType,
					}
				},
				tv_series: {
					data: hydratedTvSeries,
					pagination: {
						total_results: tvSeriesResult.found,
						total_pages: Math.ceil(tvSeriesResult.found / resultsPerType),
						current_page: 1,
						per_page: resultsPerType,
					}
				},
				persons: {
					data: hydratedPersons,
					pagination: {
						total_results: personsResult.found,
						total_pages: Math.ceil(personsResult.found / resultsPerType),
						current_page: 1,
						per_page: resultsPerType,
					}
				},
				users: {
					data: hydratedUsers,
					pagination: {
						total_results: usersResult.found,
						total_pages: Math.ceil(usersResult.found / resultsPerType),
						current_page: 1,
						per_page: resultsPerType,
					}
				},
				playlists: {
					data: hydratedPlaylists,
					pagination: {
						total_results: playlistsResult.found,
						total_pages: Math.ceil(playlistsResult.found / resultsPerType),
						current_page: 1,
						per_page: resultsPerType,
					}
				},
			};

		} catch (error) {
			request.log.error(error, 'All search failed');
			reply.status(500).send({ error: 'An internal server error occurred' });
		}
	}

	// MOVIES
	private searchMovies = async (request: FastifyRequest<{ Querystring: MovieSearchQuery }>, reply: FastifyReply) => {
		const { query, page, per_page, sort_by, genre_ids, runtime_min, runtime_max, release_date_min, release_date_max } = request.query;

   	 	request.log.info(`Searching for movies with query: "${query}", page: ${page}, per_page: ${per_page}, sort_by: ${sort_by}, genre_ids: ${genre_ids}, runtime: ${runtime_min}-${runtime_max}, release_date: ${release_date_min}-${release_date_max}`);
		
		try {
			const sortOrder = `${sort_by}:desc`;

			const searchParameters: SearchParams = {
				'q': query,
				'query_by': 'original_title,titles',
				'page': page,
				'per_page': per_page,
				'sort_by': `_text_match(buckets: 10):desc,${sortOrder}`,
			};


			const filters: string[] = [];

			// Genre
			if (genre_ids && genre_ids.length > 0) {
				const genres = genre_ids.split(',').map(id => parseInt(id, 10));
				if (genres.length > 0) {
					filters.push(`genre_ids: [${genres.join(',')}]`);
				}
			}

			// Runtime
			if (runtime_min && runtime_max) {
				filters.push(`runtime: [${runtime_min}..${runtime_max}]`);
			} else if (runtime_min) {
				filters.push(`runtime: >${runtime_min}`);
			} else if (runtime_max) {
				filters.push(`runtime: <${runtime_max}`);
			}

			// Release Date
			if (release_date_min && release_date_max) {
				filters.push(`release_date: [${release_date_min}..${release_date_max}]`);
			} else if (release_date_min) {
				filters.push(`release_date: >${release_date_min}`);
			} else if (release_date_max) {
				filters.push(`release_date: <${release_date_max}`);
			}

			if (filters.length > 0) {
				searchParameters.filter_by = filters.join(' && ');
			}

			const searchResult = await typesenseClient.collections<{ id: string }>('movies').documents().search(searchParameters);
			const movieIds = searchResult.hits?.map((hit) => hit.document.id) || [];

			if (movieIds.length === 0) {
				return {
					data: [],
					pagination: {
						total_results: 0,
						total_pages: 0,
						current_page: page,
						per_page: per_page,
					}
				};
			}

			const { data: hydratedMovies, error } = await request.supabaseClient
				.from('media_movie')
				.select('*')
				.in('id', movieIds.map(id => parseInt(id, 10)));

			if (error) throw new Error(error.message);

			const movieMap = new Map(hydratedMovies.map(movie => [String(movie.id), movie]));
			const sortedMovies = movieIds.map(id => movieMap.get(id)).filter(Boolean);

			return {
				data: sortedMovies,
				pagination: {
					total_results: searchResult.found,
					total_pages: Math.ceil(searchResult.found / per_page),
					current_page: page,
					per_page: per_page,
				}
			};
		} catch (error) {
			request.log.error(error, 'Movie search failed');
			reply.status(500).send({ error: 'An internal server error occurred' });
		}
	}

	// TV SERIES
	private searchTVSeries = async (request: FastifyRequest<{ Querystring: TvSeriesSearchQuery }>, reply: FastifyReply) => {
		const {
			query, page, per_page, sort_by,
			// Filters
			genre_ids,
			number_of_seasons_min, number_of_seasons_max,
			number_of_episodes_min, number_of_episodes_max,
			vote_average_min, vote_average_max,
			first_air_date_min, first_air_date_max
		} = request.query;

		request.log.info(`Searching for TV series with query: "${query}"`);

		try {
			const sortOrder = `${sort_by}:desc`;

			const searchParameters: SearchParams = {
				'q': query,
				'query_by': 'original_name,names',
				'page': page,
				'per_page': per_page,
				'sort_by': `_text_match(buckets: 10):desc,${sortOrder}`,
			};

			const filters: string[] = [];

			if (genre_ids && genre_ids.length > 0) {
				const genres = genre_ids.split(',').map(id => parseInt(id, 10));
				if (genres.length > 0) {
					filters.push(`genre_ids: [${genres.join(',')}]`);
				}
			}

			// Number of Seasons
			if (number_of_seasons_min && number_of_seasons_max) {
				filters.push(`number_of_seasons: [${number_of_seasons_min}..${number_of_seasons_max}]`);
			} else if (number_of_seasons_min) {
				filters.push(`number_of_seasons: >${number_of_seasons_min}`);
			} else if (number_of_seasons_max) {
				filters.push(`number_of_seasons: <${number_of_seasons_max}`);
			}

			// Number of Episodes
			if (number_of_episodes_min && number_of_episodes_max) {
				filters.push(`number_of_episodes: [${number_of_episodes_min}..${number_of_episodes_max}]`);
			} else if (number_of_episodes_min) {
				filters.push(`number_of_episodes: >${number_of_episodes_min}`);
			} else if (number_of_episodes_max) {
				filters.push(`number_of_episodes: <${number_of_episodes_max}`);
			}

			// Vote Average
			if (vote_average_min && vote_average_max) {
				filters.push(`vote_average: [${vote_average_min}..${vote_average_max}]`);
			} else if (vote_average_min) {
				filters.push(`vote_average: >${vote_average_min}`);
			} else if (vote_average_max) {
				filters.push(`vote_average: <${vote_average_max}`);
			}

			// First Air Date
			if (first_air_date_min && first_air_date_max) {
				filters.push(`first_air_date: [${first_air_date_min}..${first_air_date_max}]`);
			} else if (first_air_date_min) {
				filters.push(`first_air_date: >${first_air_date_min}`);
			} else if (first_air_date_max) {
				filters.push(`first_air_date: <${first_air_date_max}`);
			}

			if (filters.length > 0) {
				searchParameters.filter_by = filters.join(' && ');
			}

			const searchResult = await typesenseClient.collections<{ id: string }>('tv_series').documents().search(searchParameters);
			const tvSeriesIds = searchResult.hits?.map((hit) => hit.document.id) || [];

			if (tvSeriesIds.length === 0) {
				return {
					data: [],
					pagination: {
						total_results: 0,
						total_pages: 0,
						current_page: page,
						per_page: per_page,
					}
				};
			}

			const { data: hydratedTVSeries, error } = await request.supabaseClient
				.from('media_tv_series')
				.select('*')
				.in('id', tvSeriesIds.map(id => parseInt(id, 10)));

			if (error) throw new Error(error.message);

			const tvSeriesMap = new Map(hydratedTVSeries.map(tvSeries => [String(tvSeries.id), tvSeries]));
			const sortedTVSeries = tvSeriesIds.map(id => tvSeriesMap.get(id)).filter(Boolean);

			return {
				data: sortedTVSeries,
				pagination: {
					total_results: searchResult.found,
					total_pages: Math.ceil(searchResult.found / per_page),
					current_page: page,
					per_page: per_page,
				}
			};
		} catch (error) {
			request.log.error(error, 'TV series search failed');
			reply.status(500).send({ error: 'An internal server error occurred' });
		}
	}

	// PERSONS
	private searchPersons = async (request: FastifyRequest<{ Querystring: PersonSearchQuery }>, reply: FastifyReply) => {
		const {
			query, page, per_page, sort_by,
		} = request.query;

		request.log.info(`Searching for persons with query: "${query}"`);

		try {

			const sortOrder = `${sort_by}:desc`;

			const searchParameters: SearchParams = {
				'q': query,
				'query_by': 'name,also_known_as',
				'page': page,
				'per_page': per_page,
				'sort_by': `_text_match(buckets: 10):desc,${sortOrder}`,
			};

			const searchResult = await typesenseClient.collections<{ id: string }>('persons').documents().search(searchParameters);
			const personIds = searchResult.hits?.map((hit) => hit.document.id) || [];

			if (personIds.length === 0) {
				return {
					data: [],
					pagination: {
						total_results: 0,
						total_pages: 0,
						current_page: page,
						per_page: per_page,
					}
				};
			}

			const { data: hydratedPersons, error } = await request.supabaseClient
				.from('media_person')
				.select('*')
				.in('id', personIds.map(id => parseInt(id, 10)));

			if (error) throw new Error(error.message);

			const personMap = new Map(hydratedPersons.map(person => [String(person.id), person]));
			const sortedPersons = personIds.map(id => personMap.get(id)).filter(Boolean);

			return {
				data: sortedPersons,
				pagination: {
					total_results: searchResult.found,
					total_pages: Math.ceil(searchResult.found / per_page),
					current_page: page,
					per_page: per_page,
				}
			};
		} catch (error) {
			request.log.error(error, 'Person search failed');
			reply.status(500).send({ error: 'An internal server error occurred' });
		}
	}

	// USERS
	private searchUsers = async (request: FastifyRequest<{ Querystring: UserSearchQuery }>, reply: FastifyReply) => {
		const { query, page, per_page, exclude_ids } = request.query;

		request.log.info(`Searching for users with query: "${query}", page: ${page}, per_page: ${per_page}`);

		try {
			const searchParameters: SearchParams = {
				'q': query,
				'query_by': 'username,full_name',
				'page': page,
				'per_page': per_page,
				'sort_by': '_text_match(buckets: 10):desc, followers_count:desc'
			};
			if (exclude_ids && exclude_ids.length > 0) {
				const idsToExclude = exclude_ids.split(',');
				const exclusionFilter = idsToExclude.map(id => `id:!=${id}`).join(' && ');
				searchParameters.filter_by = exclusionFilter;
			}

			const searchResult = await typesenseClient.collections<{ id: string }>('users').documents().search(searchParameters);
			const userIds = searchResult.hits?.map((hit) => hit.document.id) || [];

			if (userIds.length === 0) {
				return {
					data: [],
					pagination: {
						total_results: 0,
						total_pages: 0,
						current_page: page,
						per_page: per_page,
					}
				};
			}

			const { data: hydratedUsers, error } = await request.supabaseClient
				.from('user')
				.select('*')
				.in('id', userIds);

			if (error) throw new Error(error.message);

			const userMap = new Map(hydratedUsers.map(user => [user.id, user]));
			const sortedUsers = userIds.map(id => userMap.get(id)).filter(Boolean);

			return {
				data: sortedUsers,
				pagination: {
					total_results: searchResult.found,
					total_pages: Math.ceil(searchResult.found / per_page),
					current_page: page,
					per_page: per_page,
				}
			};

		} catch (error) {
			request.log.error(error, 'User search failed');
			reply.status(500).send({ error: 'An internal server error occurred' });
		}
	}

	// PLAYLISTS
	private searchPlaylists = async (request: FastifyRequest<{ Querystring: PlaylistSearchQuery }>, reply: FastifyReply) => {
		const { query, page, per_page, sort_by } = request.query;
		const user = request.user as { sub: string } | undefined | null;
		const userId = user?.sub;

		request.log.info(`Searching for playlists with query: "${query}", user: ${userId || 'Guest'}`);
		try {
			const sortOrder = `${sort_by}:desc`;

			const searchParameters = {
				'q': query,
				'query_by': 'title,description',
				'page': page,
				'per_page': per_page,
				'filter_by': this.getPlaylistPermissionFilter(userId),
				'sort_by': sortOrder,
			};
			
			const searchResult = await typesenseClient.collections<{ id: string }>('playlists').documents().search(searchParameters);
			const playlistIds = searchResult.hits?.map((hit) => hit.document.id) || [];

			if (playlistIds.length === 0) {
				return { data: [], pagination: { total_results: 0, total_pages: 0, current_page: page, per_page: per_page } };
			}

			const { data: hydratedPlaylists, error } = await request.supabaseClient
				.from('playlists')
				.select('*')
				.in('id', playlistIds.map(id => parseInt(id, 10)));

			if (error) throw new Error(error.message);

			const playlistMap = new Map(hydratedPlaylists.map(p => [String(p.id), p]));
			const sortedPlaylists = playlistIds.map(id => playlistMap.get(id)).filter(Boolean);

			return {
				data: sortedPlaylists,
				pagination: {
					total_results: searchResult.found,
					total_pages: Math.ceil(searchResult.found / per_page),
					current_page: page,
					per_page: per_page,
				}
			};
		} catch (error) {
			request.log.error(error, 'Playlist search failed');
			reply.status(500).send({ error: 'An internal server error occurred' });
		}
	}

	/* ---------------------------------- UTILS --------------------------------- */
	private getPlaylistPermissionFilter = (userId?: string): string => {
		return userId ? `is_private:false || owner_id:=${userId} || guest_ids:=${userId}` : 'is_private:false';
	}

	private getTableNameForType = (type: string): string => {
		const tableMap: Record<string, string> = {
			movie: 'media_movie',
			tv_series: 'media_tv_series',
			person: 'media_person',
			user: 'user',
			playlist: 'playlists'
		};
		return tableMap[type];
	}

	private hydrateByIds = async (supabaseClient: SupabaseClient, tableName: string, ids: string[]): Promise<any[]> => {
		if (ids.length === 0) return [];

		const { data, error } = await supabaseClient.from(tableName).select('*').in('id', ids);
		if (error) throw new Error(`Failed to hydrate from ${tableName}: ${error.message}`);
		
		const dataMap = new Map(data.map(item => [String(item.id), item]));
		return ids.map(id => dataMap.get(id)).filter(Boolean);
	}
	/* -------------------------------------------------------------------------- */
}