import {
	isTimeBucketQueryCachePolicy,
	queryDefinitionCacheIdentity,
	resolveQueryDefinitionCache,
	type QueryDefinition,
} from "@maple/query-engine/registry"
import {
	runQueryDefinition,
	runQueryDefinitionFirst,
	type QueryEngineDirectError,
} from "@maple/query-engine/runtime"
import { Clock, Effect, Option } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import type { QueryEngineServiceApi } from "@/services/warehouse/QueryEngineService"
import type { WarehouseQueryServiceApi } from "@/services/warehouse/WarehouseQueryService"

/**
 * Applies registry cache and error policy. Services are values so the returned
 * effects have no requirements and can run inside `cachedDirect`.
 */
export interface QueryRunnerDeps {
	readonly warehouse: WarehouseQueryServiceApi
	readonly queryEngine: QueryEngineServiceApi
}

export const makeQueryRunners = ({ warehouse, queryEngine }: QueryRunnerDeps) => {
	const withPolicy = <Payload, Row, A, E extends QueryEngineDirectError>(
		def: QueryDefinition<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
		execute: Effect.Effect<A, E>,
	) =>
		Effect.gen(function* () {
			// Static policies do not require a Clock service.
			const nowMs = typeof def.cache === "function" ? yield* Clock.currentTimeMillis : 0
			const cache = resolveQueryDefinitionCache(def, payload, nowMs)
			const labelled = execute.pipe(
				Effect.tapError(() =>
					Effect.annotateCurrentSpan({
						"maple.query_engine.failed_step": `${def.id} query failed`,
					}),
				),
			)
			if (cache === undefined || isTimeBucketQueryCachePolicy(cache)) {
				return yield* labelled
			}
			return yield* queryEngine.cachedDirect(
				tenant,
				def.id,
				queryDefinitionCacheIdentity(def, payload),
				labelled,
				cache,
			)
		})

	const runQuery = <Payload, Row>(
		def: QueryDefinition<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
	) => withPolicy(def, tenant, payload, runQueryDefinition(warehouse, def, tenant, payload))

	const runQueryFirst = <Payload, Row>(
		def: QueryDefinition<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
	) =>
		withPolicy(
			def,
			tenant,
			payload,
			runQueryDefinitionFirst(warehouse, def, tenant, payload).pipe(Effect.map(Option.getOrNull)),
		)

	return { runQuery, runQueryFirst } as const
}
