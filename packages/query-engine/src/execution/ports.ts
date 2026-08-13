import type { Effect, Option } from "effect"
import type { OrgId, UserId } from "@maple/domain"
import type {
	RawSqlValidationError,
	WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseValidationError,
	WarehouseSchemaDriftError,
} from "@maple/domain/http"
import type { ResolvedWarehouseConfig } from "./backend"
import type { CompiledQuery } from "../ch"
import type { WarehouseCapabilities } from "../capabilities"
import type { WarehouseExecutorShape } from "../observability"
import type { SqlQueryOptions } from "../profiles"
import type { WarehouseExecutionError } from "./errors"
import type { WarehouseResponseLimitError } from "./response-limits"

/** The minimal tenant surface the executor reads (org scope + identity for spans). */
export interface ExecutionTenant {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly authMode: string
}

export type { SqlQueryOptions } from "../profiles"

export type { ResolvedWarehouseConfig } from "./backend"

/** Minimal client interface — raw SQL execution plus row inserts. */
export interface WarehouseSqlClient {
	readonly sql: (
		sql: string,
		options?: {
			readonly responseLimits?: {
				readonly maxRows: number
				readonly maxBytes: number
			}
		},
	) => Promise<{ data: ReadonlyArray<Record<string, unknown>> }>
	readonly insert: (datasource: string, rows: ReadonlyArray<unknown>) => Promise<void>
}

/**
 * What a query is FOR — the executor computes this and the host's `resolveRoute`
 * turns it into a concrete backend:
 *
 * - `read`   — trusted, Maple-compiled SQL (the default)
 * - `raw`    — user-authored SQL; must run on tenant-isolated credentials
 * - `ingest` — writes, plus reads of control-plane datasources that only exist
 *              in the managed write pipeline (e.g. `alert_checks`)
 */
export type RoutePurpose = "read" | "raw" | "ingest"

/** The host's routing decision: which backend, with which credentials, and why. */
export interface WarehouseRoute {
	/**
	 * Why this config was chosen — annotated on the executeSql span as
	 * `warehouse.config_source`:
	 * - `managed` — the env-level shared warehouse
	 * - `org-byo` — the org's own BYO ClickHouse credentials
	 * - `org-jwt` — the shared Tinybird warehouse behind an org-scoped JWT
	 */
	readonly source: "managed" | "org-byo" | "org-jwt"
	readonly config: ResolvedWarehouseConfig
	/** Stable logical cache partition; config changes are detected independently. */
	readonly clientCacheKey: string
}

/**
 * The injected dependencies of the warehouse executor. The host app provides
 * the driver construction (`createClient`) and the routing decision
 * (`resolveRoute`, which reads the org-override DB row or env and returns a
 * stable logical cache partition); the executor itself — error mapping, retry,
 * client cache, OrgId scoping, span instrumentation — lives in this package.
 */
export interface WarehouseExecutorDeps {
	readonly createClient: (config: ResolvedWarehouseConfig) => WarehouseSqlClient
	readonly resolveRoute: (
		tenant: ExecutionTenant,
		purpose: RoutePurpose,
		label: string,
	) => Effect.Effect<WarehouseRoute, WarehouseExecutionError>
	/**
	 * Drop whatever the host caches to answer `resolveRoute` for this tenant, and
	 * report whether that actually invalidated a per-org routing override.
	 *
	 * Exists for exactly one failure: the host serves org routing config from a
	 * stale-tolerant cache, so a BYO-ClickHouse credential rotation keeps
	 * resolving to the retired password until the entry ages out. The executor
	 * calls this once on `WarehouseAuthError` and retries the query, turning
	 * "the org is broken until the cache expires" into "the first request after
	 * the rotation pays one extra round-trip".
	 *
	 * The boolean is the retry gate, and it is the host's job to be honest about
	 * it: return `true` only when a per-org override was actually dropped.
	 * Returning `true` unconditionally would make every auth failure on the
	 * shared managed credential — where re-resolving cannot change the answer —
	 * run its query twice.
	 *
	 * Optional: hosts without per-org routing omit it and get no retry.
	 */
	readonly invalidateRoute?: (tenant: ExecutionTenant) => Effect.Effect<boolean>
}

export interface WarehouseQueryServiceShape {
	readonly query: (
		tenant: ExecutionTenant,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) => Effect.Effect<WarehouseQueryResponse, WarehouseExecutionError | WarehouseValidationError>
	/**
	 * Execute a query that deliberately spans every tenant. The compiled query
	 * must declare `.crossOrg()`, and `justification` is recorded on the span so
	 * cross-tenant reads are auditable from the traces.
	 *
	 * There is deliberately no general `sqlQuery(tenant, sql)` on this shape:
	 * arbitrary strings cannot carry a `tenantScope`, so accepting them would
	 * reintroduce the substring guard this replaced.
	 */
	readonly crossOrgQuery: <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options: SqlQueryOptions & { readonly justification: string },
	) => Effect.Effect<
		ReadonlyArray<T>,
		WarehouseExecutionError | WarehouseValidationError | WarehouseSchemaDriftError
	>
	/** Execute validated user-authored SQL with tenant-scoped credentials and hard response limits. */
	readonly rawSqlQuery: (
		tenant: ExecutionTenant,
		sql: string,
		options?: Pick<SqlQueryOptions, "profile" | "context">,
	) => Effect.Effect<
		ReadonlyArray<Record<string, unknown>>,
		WarehouseExecutionError | RawSqlValidationError
	>
	readonly compiledQuery: <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T> | ((capabilities: WarehouseCapabilities) => CompiledQuery<T>),
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, WarehouseExecutionError | WarehouseValidationError>
	/**
	 * `compiledQuery` with an explicit ceiling on how much of the response we are
	 * willing to materialize, failing with `WarehouseResponseLimitError` past it.
	 *
	 * Separate from `compiledQuery` on purpose: the extra failure mode belongs in
	 * the signature of the handful of call sites that can actually hit it, not in
	 * the error union of the ~30 endpoints that cannot.
	 */
	readonly compiledQueryBounded: <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options: SqlQueryOptions & {
			readonly responseLimits: { readonly maxRows: number; readonly maxBytes: number }
		},
	) => Effect.Effect<
		ReadonlyArray<T>,
		WarehouseExecutionError | WarehouseValidationError | WarehouseResponseLimitError
	>
	readonly compiledQueryWithCapabilities: <T>(
		tenant: ExecutionTenant,
		compile: (capabilities: WarehouseCapabilities) => CompiledQuery<T>,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, WarehouseExecutionError | WarehouseValidationError>
	readonly compiledQueryFirst: <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T> | ((capabilities: WarehouseCapabilities) => CompiledQuery<T>),
		options?: SqlQueryOptions,
	) => Effect.Effect<Option.Option<T>, WarehouseExecutionError | WarehouseValidationError>
	/**
	 * Resolve this tenant's route and capabilities once, so a fan-out that
	 * follows finds them memoized instead of each branch deriving them itself.
	 *
	 * Exists because route resolution reads per-org ClickHouse config from
	 * Postgres, and that read has been measured at ~2.9s cold. A fan-out that
	 * starts every branch at once has every branch miss the in-isolate memo:
	 * one prod trace of a single dashboard panel resolved the identical config
	 * twice concurrently at 2.90s each, while the two warehouse queries the
	 * fan-out existed to run took 428ms and 1179ms. The lookup cost more than
	 * double the work it was preparing for.
	 *
	 * Cheap and idempotent on a warm memo, so callers may invoke it
	 * unconditionally. Errors are swallowed: this is a warm-up, and the real
	 * query behind it reports failures with proper context. Never let this
	 * change the error semantics of the path it precedes.
	 */
	readonly warmRoute: (tenant: ExecutionTenant, options?: SqlQueryOptions) => Effect.Effect<void>
	readonly ingest: <T>(
		tenant: ExecutionTenant,
		datasource: string,
		rows: ReadonlyArray<T>,
	) => Effect.Effect<void, WarehouseExecutionError>
	/**
	 * Present this service as the package-level `WarehouseExecutor` for a given
	 * tenant — the single managed-warehouse implementation of that interface.
	 */
	readonly asExecutor: (tenant: ExecutionTenant) => WarehouseExecutorShape
}
