import type { Effect, Option } from "effect"
import type { OrgId, UserId } from "@maple/domain"
import type {
	RawSqlValidationError,
	WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseValidationError,
} from "@maple/domain/http"
import type { ResolvedWarehouseConfig } from "./backend"
import type { CompiledQuery } from "../ch"
import type { WarehouseExecutorShape } from "../observability"
import type { SqlQueryOptions } from "../profiles"
import type { WarehouseSqlError } from "./errors"

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
	) => Effect.Effect<WarehouseRoute, WarehouseSqlError>
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
	/** Execute validated user-authored SQL with tenant-scoped credentials and hard response limits. */
	readonly rawSqlQuery: (
		tenant: ExecutionTenant,
		sql: string,
		options?: Pick<SqlQueryOptions, "profile" | "context">,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, WarehouseSqlError | RawSqlValidationError>
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
	) => Effect.Effect<void, WarehouseSqlError>
	/**
	 * Present this service as the package-level `WarehouseExecutor` for a given
	 * tenant — the single managed-warehouse implementation of that interface.
	 */
	readonly asExecutor: (tenant: ExecutionTenant) => WarehouseExecutorShape
}
