// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import type { WarehouseCapabilities } from "../capabilities"
import type { QueryProfileName, WarehouseQuerySettings } from "../profiles/query-profile"
import {
	resolveDirectRouteCachePolicy,
	type DirectRouteCachePolicy,
	type DirectRouteCachePolicyInput,
} from "../runtime/cache-policy"

/** Range-independent identity lets overlapping windows reuse stored buckets. */
export interface TimeBucketQueryCachePolicy<Payload> {
	readonly kind: "time-buckets"
	readonly identity: (payload: Payload) => unknown
	/** Whole-result fallback when bucket caching cannot serve the request. */
	readonly fallback: DirectRouteCachePolicy
}

export type QueryCachePolicy<Payload> =
	| DirectRouteCachePolicyInput
	| TimeBucketQueryCachePolicy<Payload>
	| undefined
	| ((payload: Payload, nowMs: number) => DirectRouteCachePolicyInput | undefined)

/** Compile and execution policy for one semantic warehouse query. */
export interface QueryDefinition<Payload, Row> {
	readonly id: string
	/** Bump when compilation or decoded-row semantics change incompatibly. */
	readonly revision: number
	readonly profile: QueryProfileName
	readonly settings?: WarehouseQuerySettings | ((payload: Payload) => WarehouseQuerySettings | undefined)
	/** Required; `undefined` explicitly disables caching. */
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

export const queryDefinitionCacheIdentity = <Payload, Row>(
	definition: QueryDefinition<Payload, Row>,
	payload: Payload,
	input: unknown = payload,
) => ({
	definition: definition.id,
	revision: definition.revision,
	input,
})
