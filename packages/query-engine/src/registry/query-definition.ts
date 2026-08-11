import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import type { WarehouseCapabilities } from "../capabilities"
import type { QueryProfileName, WarehouseQuerySettings } from "../profiles/query-profile"
import {
	resolveDirectRouteCachePolicy,
	type DirectRouteCachePolicy,
	type DirectRouteCachePolicyInput,
} from "../runtime/cache-policy"

/**
 * A timeseries cache stores independently reusable time buckets. Its identity
 * deliberately excludes the requested range; the bucket cache owns that part
 * of the key and can therefore reuse an overlapping window.
 */
export interface TimeBucketQueryCachePolicy<Payload> {
	readonly kind: "time-buckets"
	readonly identity: (payload: Payload) => unknown
	/** Whole-result policy used when bucket caching cannot serve the request. */
	readonly fallback: DirectRouteCachePolicy
}

export type QueryCachePolicy<Payload> =
	| DirectRouteCachePolicyInput
	| TimeBucketQueryCachePolicy<Payload>
	| undefined
	| ((payload: Payload, nowMs: number) => DirectRouteCachePolicyInput | undefined)

/**
 * One semantic warehouse query, independent of the HTTP/RPC adapter that
 * supplied its input. The definition is the shared unit of compilation,
 * execution policy, observability, and cache identity.
 */
export interface QueryDefinition<Payload, Row> {
	readonly id: string
	/** Bump when compilation or decoded-row semantics change incompatibly. */
	readonly revision: number
	readonly profile: QueryProfileName
	readonly settings?: WarehouseQuerySettings | ((payload: Payload) => WarehouseQuerySettings | undefined)
	/** Required: `undefined` is an explicit decision to leave this query uncached. */
	readonly cache: QueryCachePolicy<Payload>
	/** Resolve live skip-index capabilities only when the compiled plan can use them. */
	readonly capabilityAware?: boolean
	readonly compile: (
		payload: Payload,
		orgId: string,
		capabilities: WarehouseCapabilities,
	) => CompiledQuery<Row>
}

type QueryDefinitionInput<Payload, Row> = Omit<QueryDefinition<Payload, Row>, "revision"> & {
	readonly revision?: number
}

/** Definitions start at revision 1 without repeating that noise at every declaration. */
export const defineQuery = <Payload, Row>(
	definition: QueryDefinitionInput<Payload, Row>,
): QueryDefinition<Payload, Row> => ({ revision: 1, ...definition })

export const makeTimeBucketQueryCachePolicy = <Payload>(options: {
	readonly identity: (payload: Payload) => unknown
	readonly fallback?: DirectRouteCachePolicyInput
}): TimeBucketQueryCachePolicy<Payload> => ({
	kind: "time-buckets",
	identity: options.identity,
	fallback: resolveDirectRouteCachePolicy(options.fallback),
})

export const isTimeBucketQueryCachePolicy = <Payload>(
	policy: DirectRouteCachePolicyInput | TimeBucketQueryCachePolicy<Payload> | undefined,
): policy is TimeBucketQueryCachePolicy<Payload> =>
	typeof policy === "object" && "kind" in policy && policy.kind === "time-buckets"

export const resolveQueryDefinitionCache = <Payload, Row>(
	definition: QueryDefinition<Payload, Row>,
	payload: Payload,
	nowMs: number,
): DirectRouteCachePolicy | TimeBucketQueryCachePolicy<Payload> | undefined => {
	const policy =
		typeof definition.cache === "function" ? definition.cache(payload, nowMs) : definition.cache
	if (policy === undefined || isTimeBucketQueryCachePolicy(policy)) return policy
	return resolveDirectRouteCachePolicy(policy)
}

/** Canonical cache identity shared by every transport adapter for a definition. */
export const queryDefinitionCacheIdentity = <Payload, Row>(
	definition: QueryDefinition<Payload, Row>,
	payload: Payload,
	input: unknown = payload,
) => ({
	definition: definition.id,
	revision: definition.revision,
	input,
})
