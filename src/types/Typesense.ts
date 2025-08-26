export interface TypesenseHit<T> {
  document: T;
  text_match?: number;
}

export interface TypesenseSearchResult<T> {
  hits?: TypesenseHit<T>[];
  found: number;
  per_page: number;
}