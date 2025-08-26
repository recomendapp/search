import createError from "@fastify/error";
import type { JWT } from "@fastify/jwt";
import {
  SupabaseClient,
  SupabaseClientOptions,
  User,
  createClient,
} from "@supabase/supabase-js";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

const AuthorizationTokenInvalidError = createError(
	"FST_SB_AUTHORIZATION_TOKEN_INVALID",
	"Authorization token is invalid",
	401,
);
const NoUserDataFoundError = createError(
	"FST_SB_NO_USER_DATA_FOUND",
	"No user data found in the request. Make sure to run request.jwtVerify() before trying to access the user.",
	401,
);

declare module "fastify" {
	export interface FastifyInstance {
		// supabaseClient: SupabaseClient;
		jwt: JWT;
	}
	export interface FastifyRequest {
		_supabaseClient: SupabaseClient;
		// supabaseClient: SupabaseClient;
		supabaseUser: User;
	}
}

export type FastifySupabasePluginOpts<Database = any> = {
	url: string;
	serviceKey: string;
	anonKey: string;
	options?: SupabaseClientOptions<"public">;
	extraHeaders?: (request: FastifyRequest) => Record<string, string>;
};

const fastifySupabase: FastifyPluginCallback<FastifySupabasePluginOpts> = (
  fastify,
  opts,
  next,
) => {
	const { url, serviceKey, anonKey, options, extraHeaders } = opts;

	const supabase = createClient(url, serviceKey, options);

	if (fastify.supabaseClient) {
		return next(new Error("fastify-supabase has already been registered"));
	}

	fastify.decorate("supabaseClient", supabase);
	fastify.decorateRequest("_supabaseClient");

	fastify.decorateRequest("supabaseClient", {
		getter() {
			const req = this as unknown as FastifyRequest;
		
			if (req._supabaseClient) return req._supabaseClient;

			const user = req.user as { role?: string } | null;
			const additionalHeaders = extraHeaders ? extraHeaders(req) : {};

			if (user?.role === "service_role") {
				req._supabaseClient = fastify.supabaseClient;
			} else {
				const client = createClient(url, anonKey, {
					...options,
					auth: { ...options?.auth, persistSession: false },
					global: {
						...options?.global,
						headers: {
							...options?.global?.headers,
							...(user?.role && user.role !== "anon" ? { Authorization: `Bearer ${fastify.jwt.lookupToken(req)}` } : {}),
							...additionalHeaders,
						},
					},
				});
				req._supabaseClient = client;
			}

			if (!req._supabaseClient) {
				throw new AuthorizationTokenInvalidError();
			}

			return req._supabaseClient;
		},
	}, ["user"]);

	fastify.decorateRequest("supabaseUser", {
		getter() {
			const req = this as unknown as FastifyRequest;
			if (!req.user) {
			throw new NoUserDataFoundError();
			}
			return req.user as User;
		},
	}, ["user"]);

	next();
};

export default fp(fastifySupabase, {
	fastify: "5.x",
	name: "fastify-supabase",
	dependencies: ["@fastify/jwt"],
});