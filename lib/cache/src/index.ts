// @maple/cache
//
// A cache port and a get-or-compute service, with no knowledge of queries or
// the warehouse. Split out of @maple/query-engine because most of its callers
// were never query code — billing, Slack, digests, org quarantine and spend
// limits all pulled in the whole query engine to cache a value.
//
// The query-shaped half stayed behind: `bucket-cache` understands QuerySpec
// time buckets, so it lives in @maple/query-engine/caching and depends on this
// package rather than the other way round.

export * from "./cache-backend"
export * from "./edge-cache"
export * from "./outbound-slots"
