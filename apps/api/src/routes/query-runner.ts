import type { QueryDef } from "@maple/query-engine/registry"
import type { QueryEngineDirectError } from "@maple/query-engine/runtime"
import { Effect, Option } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

/**
 * Execute registry-declared warehouse queries.
 *
 * This is the single place that applies a `QueryDef`'s cost profile, settings,
 * span context, error label and cache policy — the five things that used to be
 * hand-repeated in each of 61 handlers, where the cache in particular was
 * silently omitted 50 times.
 *
 * Handlers keep their own row-to-response mapping. What they lose is the
 * plumbing, not the presentation.
 */

/**
 * Settings may be static or payload-dependent. Resolved to a spread so an
 * absent/undefined result omits the key entirely rather than passing an
 * explicit `settings: undefined`, which would read as "clear the profile
 * defaults" downstream.
 */
const resolveSettings = <Payload, Row>(def: QueryDef<Payload, Row>, payload: Payload) => {
	const settings = typeof def.settings === "function" ? def.settings(payload) : def.settings
	return settings === undefined ? {} : { settings }
}

/**
 * Shared tail: annotate failures with the query id, then apply the declared
 * cache policy (or don't). `cachedDirect` wraps the whole execution so a hit
 * skips the warehouse entirely, and it takes the raw payload as key input —
 * it snaps timestamps and sorts set-valued keys itself, which is why the
 * payload goes in unnormalized.
 */
const withPolicy = <Payload, Row, A, E extends QueryEngineDirectError>(
	def: QueryDef<Payload, Row>,
	tenant: TenantContext,
	payload: Payload,
	execute: Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		const labelled = execute.pipe(
			// Same annotation the old inline `mapExecError` produced, with the label
			// derived from `def.id` rather than a hand-written string that could
			// disagree with the span context beside it.
			Effect.tapError(() =>
				Effect.annotateCurrentSpan({
					"maple.query_engine.failed_step": `${def.id} query failed`,
				}),
			),
		)
		if (def.cache === undefined) {
			return yield* labelled
		}
		return yield* queryEngine.cachedDirect(tenant, def.id, payload, labelled, def.cache)
	})

/**
 * Run a `QueryDef` that returns many rows.
 *
 * Rows-vs-first-row is a call-site concern rather than a field on the def: the
 * same compiled query legitimately supports both, and `compiledQueryFirst`
 * takes the identical `CompiledQuery`. Putting it in the def would only let a
 * caller disagree with it.
 */
export const runQuery = <Payload, Row>(
	def: QueryDef<Payload, Row>,
	tenant: TenantContext,
	payload: Payload,
) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		return yield* withPolicy(
			def,
			tenant,
			payload,
			warehouse.compiledQuery(tenant, def.compile(payload, tenant.orgId), {
				profile: def.profile,
				...resolveSettings(def, payload),
				context: def.id,
			}),
		)
	})

/**
 * Run a `QueryDef` that returns at most one row, as `Row | null`.
 *
 * Null rather than `Option` because every current caller immediately does
 * `Option.getOrNull` to build a nullable response field.
 */
export const runQueryFirst = <Payload, Row>(
	def: QueryDef<Payload, Row>,
	tenant: TenantContext,
	payload: Payload,
) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		return yield* withPolicy(
			def,
			tenant,
			payload,
			warehouse
				.compiledQueryFirst(tenant, def.compile(payload, tenant.orgId), {
					profile: def.profile,
					...resolveSettings(def, payload),
					context: def.id,
				})
				.pipe(Effect.map(Option.getOrNull)),
		)
	})
