import { createClient as createClickHouseClient } from "@clickhouse/client-web"
import { Tinybird } from "@tinybirdco/sdk"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import type { WarehouseQueryRequest } from "@maple/domain/http"
import {
	makeWarehouseExecutor,
	toWarehouseQueryError,
	type ResolvedWarehouseConfig,
	type SqlQueryOptions,
	type WarehouseExecutorDeps,
	type WarehouseQueryServiceShape,
	type WarehouseSqlClient,
} from "@maple/query-engine/execution"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { Env } from "./Env"
import type { TenantContext } from "../services/AuthService"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"

// ---------------------------------------------------------------------------
// WarehouseQueryService — the API's managed-warehouse executor.
//
// The execution logic (SQL run, retry, error mapping, client cache, OrgId
// scoping, span instrumentation) lives in `@maple/query-engine/execution`. This
// file is the host-app wiring: it constructs the actual ClickHouse / Tinybird
// drivers (the ONLY place `@clickhouse/client-web` + `@tinybirdco/sdk` are
// used) and resolves the per-org upstream config from the DB + env, injecting
// both into `makeWarehouseExecutor`.
// ---------------------------------------------------------------------------

// Re-export the executor types so existing import sites stay stable.
export type { WarehouseQueryServiceShape, SqlQueryOptions }

type ClickHouseConfig = Extract<ResolvedWarehouseConfig, { _tag: "clickhouse" }>
type TinybirdConfig = Extract<ResolvedWarehouseConfig, { _tag: "tinybird" }>

const createClickHouseSqlClient = (config: ClickHouseConfig): WarehouseSqlClient => {
	const client = createClickHouseClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
	})
	return {
		sql: async (sql: string) => {
			const resultSet = await client.query({
				query: sql,
				format: "JSONEachRow",
			})
			const data = await resultSet.json<Record<string, unknown>>()
			return { data }
		},
		insert: async (_datasource, _rows) => {
			// ClickHouse is READ-ONLY for Maple: the managed CLICKHOUSE_URL endpoint is
			// a query gateway that rejects inserts ("Only SELECT or DESCRIBE queries are
			// supported. Got: InsertQuery"), and a BYO org override is a read concern.
			// All ingest goes to Tinybird's Events API (see resolveIngestConfig), so this
			// must never be reached — fail loudly instead of silently 500'ing.
			throw new Error("ClickHouse is read-only for Maple — ingest must use Tinybird")
		},
	}
}

const createTinybirdSdkSqlClient = (config: TinybirdConfig): WarehouseSqlClient => {
	const client = new Tinybird({
		baseUrl: config.host,
		token: config.token,
		datasources: {},
		pipes: {},
		devMode: false,
	})
	return {
		sql: async (sql: string) => client.sql(sql),
		insert: async (datasource, rows) => {
			if (rows.length === 0) return
			const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")
			const url = `${config.host.replace(/\/$/, "")}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-ndjson",
					Authorization: `Bearer ${config.token}`,
				},
				body: ndjson,
			})
			if (!response.ok) {
				const body = await response.text().catch(() => "")
				throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`)
			}
		},
	}
}

const createClient = (config: ResolvedWarehouseConfig): WarehouseSqlClient =>
	config._tag === "clickhouse" ? createClickHouseSqlClient(config) : createTinybirdSdkSqlClient(config)

let sqlClientFactory: typeof createClient = createClient

export class WarehouseQueryService extends Context.Service<
	WarehouseQueryService,
	WarehouseQueryServiceShape
>()("@maple/api/lib/WarehouseQueryService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const orgClickHouseSettings = yield* OrgClickHouseSettingsService

		/**
		 * Resolve the upstream config for this tenant's queries.
		 *
		 * Resolution order:
		 *   1. Per-org BYO ClickHouse row (`org_clickhouse_settings`)
		 *   2. Env-level managed ClickHouse (`CLICKHOUSE_URL` set)
		 *   3. Env-level managed Tinybird (`TINYBIRD_HOST` + `TINYBIRD_TOKEN`)
		 */
		// The managed (env-level) upstream: ClickHouse when CLICKHOUSE_URL is set,
		// otherwise the managed Tinybird pipeline. This is the canonical WRITE
		// target — demo-seed, service-map rollups and alert-check inserts all land
		// here — and the read-path fallback when an org has no BYO override.
		const resolveManagedConfig = Effect.fn("WarehouseQueryService.resolveManagedConfig")(function* () {
			if (Option.isSome(env.CLICKHOUSE_URL)) {
				yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
				return {
					config: {
						_tag: "clickhouse" as const,
						url: env.CLICKHOUSE_URL.value,
						username: env.CLICKHOUSE_USER,
						password: Option.match(env.CLICKHOUSE_PASSWORD, {
							onNone: () => Redacted.value(env.TINYBIRD_TOKEN),
							onSome: Redacted.value,
						}),
						database: env.CLICKHOUSE_DATABASE,
					},
					source: "managed" as const,
				}
			}

			yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
			return {
				config: {
					_tag: "tinybird" as const,
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
				},
				source: "managed" as const,
			}
		})

		/**
		 * Read-path config. A per-org BYO ClickHouse row (`org_clickhouse_settings`)
		 * overrides the managed upstream for that org's queries; otherwise we fall
		 * back to the managed config.
		 */
		const resolveConfig: WarehouseExecutorDeps["resolveConfig"] = Effect.fn(
			"WarehouseQueryService.resolveSqlConfig",
		)(function* (tenant, label) {
			const override = yield* orgClickHouseSettings
				.resolveRuntimeConfig(tenant.orgId)
				.pipe(Effect.mapError((error) => toWarehouseQueryError(label, error)))

			if (Option.isSome(override)) {
				yield* Effect.annotateCurrentSpan("clientSource", "org_override")
				yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
				return {
					config: {
						_tag: "clickhouse" as const,
						url: override.value.url,
						username: override.value.user,
						password: override.value.password,
						database: override.value.database,
					},
					source: "org_override" as const,
				}
			}

			yield* Effect.annotateCurrentSpan("clientSource", "managed")
			return yield* resolveManagedConfig()
		})

		/**
		 * Write-path config. Inserts (demo seed, service-map rollups, alert checks)
		 * ALWAYS go to the Tinybird ingest pipeline (Events API) — never ClickHouse.
		 *
		 * BILLING: this path bypasses the ingest gateway, which is where Autumn usage
		 * metering happens. Today's only `ingest` callers — demo seed, service-map
		 * rollups, alert checks — are all derived/internal/demo data and deliberately
		 * unmetered. Net-new *customer* telemetry must go through the ingest gateway
		 * (as the Cloudflare edge-metrics poller does) so it is metered, not direct `ingest`.
		 *
		 * This is deliberately NOT `resolveManagedConfig()`: when `CLICKHOUSE_URL` is
		 * set, the *managed* backend is a READ-ONLY ClickHouse query gateway that
		 * rejects inserts ("DB::Exception: Only SELECT or DESCRIBE queries are
		 * supported. Got: InsertQuery"). A per-org BYO ClickHouse override is also a
		 * read concern. Tinybird is the only writable warehouse, so ingest pins to
		 * it unconditionally (TINYBIRD_HOST/TOKEN are required env, always present).
		 * Routing writes anywhere else broke demo-seed onboarding.
		 */
		const resolveIngestConfig: WarehouseExecutorDeps["resolveConfig"] = Effect.fn(
			"WarehouseQueryService.resolveIngestConfig",
		)(function* (tenant, _label) {
			yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
			yield* Effect.annotateCurrentSpan("clientSource", "managed")
			yield* Effect.annotateCurrentSpan("ingest.routing", "tinybird")
			yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
			return {
				config: {
					_tag: "tinybird" as const,
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
				},
				source: "managed" as const,
			}
		})

		return makeWarehouseExecutor({
			createClient: (config) => sqlClientFactory(config),
			resolveConfig,
			resolveIngestConfig,
		})
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	static readonly query = (
		tenant: TenantContext,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) => this.use((service) => service.query(tenant, payload, options))

	static readonly compiledQuery = <T>(
		tenant: TenantContext,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) => this.use((service) => service.compiledQuery(tenant, compiled, options))

	static readonly compiledQueryFirst = <T>(
		tenant: TenantContext,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) => this.use((service) => service.compiledQueryFirst(tenant, compiled, options))

	static readonly ingest = <T>(tenant: TenantContext, datasource: string, rows: ReadonlyArray<T>) =>
		this.use((service) => service.ingest(tenant, datasource, rows))
}

/**
 * Layer that provides the package-level `WarehouseExecutor` for a tenant,
 * backed by `WarehouseQueryService`. The executor name is a public contract
 * from `@maple/query-engine`; only the wiring lives here.
 */
export const makeWarehouseExecutorFromTenant = (tenant: TenantContext) =>
	Layer.effect(
		WarehouseExecutor,
		Effect.map(WarehouseQueryService, (warehouse) => warehouse.asExecutor(tenant)),
	)

export const __testables = {
	setClientFactory: (factory: typeof createClient) => {
		sqlClientFactory = factory
	},
	reset: () => {
		sqlClientFactory = createClient
	},
	createClickHouseSqlClient,
	createTinybirdSdkSqlClient,
}
