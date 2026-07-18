import type { Effect, Option } from "effect"
import type { OrgId } from "@maple/domain"
import type {
	WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseQueryError,
	WarehouseValidationError,
} from "@maple/domain/http"
import type { CompiledQuery } from "../ch"
import type { WarehouseExecutorShape } from "../observability"
import type { QueryProfileName, WarehouseQuerySettings } from "../profiles"
import type { WarehouseSqlError } from "./errors"

/** The minimal tenant surface the executor reads (org scope + identity for spans). */
export interface ExecutionTenant {
	readonly orgId: OrgId
	readonly userId: string
	readonly authMode: string
}

export type SqlQueryOptions = {
	profile?: QueryProfileName
	settings?: WarehouseQuerySettings
	/**
	 * Semantic name for the query (e.g. "errorsByType", "spanHierarchy").
	 * Annotated on the executeSql span as `query.context` so traces can be
	 * filtered and grouped by call site without re-running the SQL.
	 */
	context?: string
	/**
	 * Read this query from the INGEST config (managed Tinybird) instead of the
	 * per-org read config. Use for Maple control-plane datasources that are
	 * written via `ingest` (which is hard-pinned to Tinybird) and therefore do
	 * NOT exist in a per-org BYO ClickHouse — e.g. `alert_checks`. Keeps the
	 * read symmetric with the write. Falls back to `resolveConfig` if the host
	 * did not inject a `resolveIngestConfig`.
	 */
	pinToIngestConfig?: boolean
	/**
	 * Mark this as untrusted, user-authored raw SQL. When set and the resolved
	 * backend is the shared managed Tinybird warehouse, the host swaps the shared
	 * admin token for a per-org scoped read JWT, so tenant isolation is enforced
	 * by Tinybird server-side instead of by SQL-string checks. No-op for BYO
	 * ClickHouse orgs (already isolated by their own credentials).
	 */
	scopeToOrgJwt?: boolean
	/** Apply the hard pre-buffer limits used for untrusted raw-SQL responses. */
	rawResponseLimits?: boolean
}

export type WarehouseProvider = "clickhouse" | "tinybird"

/** Resolved upstream connection config for a tenant's queries. */
export type ResolvedWarehouseConfig =
	| {
			readonly _tag: "clickhouse"
			readonly provider: WarehouseProvider
			readonly url: string
			readonly username: string
			readonly password: string
			readonly database: string
	  }
	| {
			readonly _tag: "tinybird"
			readonly provider: "tinybird"
			readonly host: string
			readonly token: string
	  }

/** Minimal client interface — raw SQL execution plus row inserts. */
export interface WarehouseSqlClient {
	readonly sql: (
		sql: string,
		options?: { readonly rawResponseLimits?: boolean },
	) => Promise<{ data: ReadonlyArray<Record<string, unknown>> }>
	readonly insert: (datasource: string, rows: ReadonlyArray<unknown>) => Promise<void>
}

/**
 * The injected dependencies of the warehouse executor. The host app provides
 * the driver construction (`createClient`) and the per-org config resolution
 * (`resolveConfig`, which reads the org-override DB row / env and emits the
 * `clientSource` / `db.client` span annotations); the executor itself — error
 * mapping, retry, client cache, OrgId scoping, span instrumentation — lives in
 * this package.
 */
/** Per-call hints the host config resolver may act on. */
export interface ResolveConfigOptions {
	/** Untrusted raw SQL — use a per-org scoped read token on the managed backend. */
	readonly scopeToOrgJwt?: boolean
}

export interface WarehouseExecutorDeps {
	readonly createClient: (config: ResolvedWarehouseConfig) => WarehouseSqlClient
	readonly resolveConfig: (
		tenant: ExecutionTenant,
		label: string,
		options?: ResolveConfigOptions,
	) => Effect.Effect<
		{ readonly config: ResolvedWarehouseConfig; readonly source: "managed" | "org_override" },
		WarehouseSqlError
	>
	/**
	 * Config resolver for the WRITE path (`ingest`). Inserts must land in the
	 * managed pipeline (Tinybird in the cloud), NOT a per-org BYO ClickHouse
	 * read override — that override is a query-side concern. Falls back to
	 * `resolveConfig` when omitted.
	 */
	readonly resolveIngestConfig?: (
		tenant: ExecutionTenant,
		label: string,
		options?: ResolveConfigOptions,
	) => Effect.Effect<
		{ readonly config: ResolvedWarehouseConfig; readonly source: "managed" | "org_override" },
		WarehouseQueryError
	>
}

export interface WarehouseQueryServiceShape {
	readonly query: (
		tenant: ExecutionTenant,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) => Effect.Effect<WarehouseQueryResponse, WarehouseSqlError | WarehouseValidationError>
	readonly sqlQuery: (
		tenant: ExecutionTenant,
		sql: string,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, WarehouseSqlError | WarehouseValidationError>
	readonly compiledQuery: <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<T>, WarehouseSqlError | WarehouseValidationError>
	readonly compiledQueryFirst: <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) => Effect.Effect<Option.Option<T>, WarehouseSqlError | WarehouseValidationError>
	readonly ingest: <T>(
		tenant: ExecutionTenant,
		datasource: string,
		rows: ReadonlyArray<T>,
	) => Effect.Effect<void, WarehouseQueryError>
	/**
	 * Present this service as the package-level `WarehouseExecutor` for a given
	 * tenant — the single managed-warehouse implementation of that interface.
	 */
	readonly asExecutor: (tenant: ExecutionTenant) => WarehouseExecutorShape
}
