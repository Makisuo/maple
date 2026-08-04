import type { QueryDef } from "@maple/query-engine/registry"
import type { QueryEngineDirectError } from "@maple/query-engine/runtime"
import { Clock, Effect, Option } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import type { QueryEngineServiceShape } from "@/services/warehouse/QueryEngineService"
import type { WarehouseQueryServiceShape } from "@/services/warehouse/WarehouseQueryService"

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
 *
 * The services are taken as VALUES, not read from context, and the runners are
 * built once per handler group. That is load-bearing rather than stylistic:
 * `QueryEngineService.cachedDirect` accepts an `Effect` with no requirements, so
 * a context-reading runner could never be composed inside a cache wrapper —
 * which `spanHierarchy` needs, since its probe must only fire on a cache miss.
 * Currying here keeps every call site written as `runQuery(def, tenant, payload)`
 * while the effects it returns carry `R = never`.
 */
export interface QueryRunnerDeps {
	readonly warehouse: WarehouseQueryServiceShape
	readonly queryEngine: QueryEngineServiceShape
}

export const makeQueryRunners = ({ warehouse, queryEngine }: QueryRunnerDeps) => {
	/**
	 * Settings may be static or payload-dependent. Resolved to a spread so an
	 * absent result omits the key entirely rather than passing an explicit
	 * `settings: undefined`, which would read as "clear the profile defaults".
	 */
	const resolveSettings = <Payload, Row>(def: QueryDef<Payload, Row>, payload: Payload) => {
		const settings = typeof def.settings === "function" ? def.settings(payload) : def.settings
		return settings === undefined ? {} : { settings }
	}

	/**
	 * Annotate failures with the query id, then apply the declared cache policy
	 * (or don't). `cachedDirect` wraps the whole execution so a hit skips the
	 * warehouse entirely, and it takes the raw payload as key input — it snaps
	 * timestamps and sorts set-valued keys itself, which is why the payload goes
	 * in unnormalized.
	 */
	const withPolicy = <Payload, Row, A, E extends QueryEngineDirectError>(
		def: QueryDef<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
		execute: Effect.Effect<A, E>,
	) =>
		Effect.gen(function* () {
			// Only read the clock when a def actually needs it — a static policy
			// must not pay for, or depend on, a Clock read.
			const cache =
				typeof def.cache === "function"
					? def.cache(payload, yield* Clock.currentTimeMillis)
					: def.cache
			const labelled = execute.pipe(
				// Same annotation the old inline `mapExecError` produced, with the
				// label derived from `def.id` rather than a hand-written string that
				// could disagree with the span context beside it.
				Effect.tapError(() =>
					Effect.annotateCurrentSpan({
						"maple.query_engine.failed_step": `${def.id} query failed`,
					}),
				),
			)
			if (cache === undefined) {
				return yield* labelled
			}
			return yield* queryEngine.cachedDirect(tenant, def.id, payload, labelled, cache)
		})

	/**
	 * Run a `QueryDef` that returns many rows.
	 *
	 * Rows-vs-first-row is a call-site concern rather than a field on the def:
	 * the same compiled query legitimately supports both, and
	 * `compiledQueryFirst` takes the identical `CompiledQuery`. Putting it in the
	 * def would only let a caller disagree with it.
	 */
	const runQuery = <Payload, Row>(
		def: QueryDef<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
	) =>
		withPolicy(
			def,
			tenant,
			payload,
			warehouse.compiledQuery(tenant, def.compile(payload, tenant.orgId), {
				profile: def.profile,
				...resolveSettings(def, payload),
				context: def.id,
			}),
		)

	/**
	 * Run a `QueryDef` that returns at most one row, as `Row | null`.
	 *
	 * Null rather than `Option` because every current caller immediately does
	 * `Option.getOrNull` to build a nullable response field.
	 */
	const runQueryFirst = <Payload, Row>(
		def: QueryDef<Payload, Row>,
		tenant: TenantContext,
		payload: Payload,
	) =>
		withPolicy(
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

	return { runQuery, runQueryFirst } as const
}
