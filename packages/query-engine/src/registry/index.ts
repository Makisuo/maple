/**
 * Declarative warehouse query registry.
 *
 * Kept out of the root barrel deliberately: definitions include runtime policy
 * and execution metadata, while the root barrel stays driver-free for web/cli.
 */
export {
	defineQuery,
	isTimeBucketQueryCachePolicy,
	makeTimeBucketQueryCachePolicy,
	queryDefinitionCacheIdentity,
	resolveQueryDefinitionCache,
	type QueryCachePolicy,
	type QueryDefinition,
	type TimeBucketQueryCachePolicy,
} from "./query-definition"
export * from "./logs"
export * as Queries from "./queries"
