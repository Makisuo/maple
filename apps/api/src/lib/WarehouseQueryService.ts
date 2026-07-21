import { createClient as createClickHouseClient } from "@clickhouse/client-web"
import { Tinybird } from "@tinybirdco/sdk"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { WarehouseConfigError, type WarehouseQueryRequest } from "@maple/domain/http"
import {
	makeWarehouseExecutor,
	toWarehouseQueryError,
	WarehouseResponseLimitError,
	type ClickHouseProtocolBackendConfig,
	type ResolvedWarehouseConfig,
	type SqlQueryOptions,
	type TinybirdBackendConfig,
	type WarehouseExecutorDeps,
	type WarehouseQueryServiceShape,
	type WarehouseSqlClient,
} from "@maple/query-engine/execution"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { Env } from "./Env"
import type { TenantContext } from "../services/AuthService"
import { OrgClickHouseSettingsService } from "../services/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "../services/TinybirdOrgTokenService"

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

const createClickHouseSqlClient = (config: ClickHouseProtocolBackendConfig): WarehouseSqlClient => {
	const client = createClickHouseClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
	})
	return {
		sql: async (sql: string, options) => {
			const resultSet = await client.query({
				query: sql,
				format: "JSONEachRow",
			})
			const limits = options?.responseLimits
			if (limits === undefined) {
				const data = await resultSet.json<Record<string, unknown>>()
				return { data }
			}

			const data: Array<Record<string, unknown>> = []
			const encoder = new TextEncoder()
			let encodedBytes = 0
			const reader = resultSet.stream().getReader()
			try {
				while (true) {
					const chunk = await reader.read()
					if (chunk.done) break
					for (const row of chunk.value) {
						encodedBytes += encoder.encode(row.text).byteLength + 1
						if (encodedBytes > limits.maxBytes) {
							await reader.cancel().catch(() => undefined)
							throw new WarehouseResponseLimitError({
								kind: "bytes",
								message: `Raw SQL results may contain at most ${limits.maxBytes} encoded bytes`,
							})
						}
						data.push(row.json<Record<string, unknown>>())
						if (data.length > limits.maxRows) {
							await reader.cancel().catch(() => undefined)
							throw new WarehouseResponseLimitError({
								kind: "rows",
								message: `Raw SQL results may contain at most ${limits.maxRows} rows`,
							})
						}
					}
				}
			} finally {
				reader.releaseLock()
			}
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

// The Tinybird SDK's `sql()` calls `response.json()` on the raw response with no empty-body guard,
// so a successful (2xx) query that matches zero rows — which can come back with an empty body —
// throws `SyntaxError: "Unexpected end of JSON input"`. Treat ONLY that exact shape as zero rows: a
// `SyntaxError` with any other message (e.g. "Unexpected token < in JSON") means Tinybird returned
// an HTML error page and must keep propagating as a real WarehouseClientError.
const isEmptyJsonBodyError = (error: unknown): boolean =>
	error instanceof SyntaxError && /unexpected end of json input/i.test(error.message)

const boundedResponseFetch =
	(maxBytes: number, requestFetch: typeof fetch = fetch): typeof fetch =>
	async (input, init) => {
		const response = await requestFetch(input, init)
		if (response.body === null) return response

		const reader = response.body.getReader()
		const chunks: Uint8Array[] = []
		let totalBytes = 0
		try {
			while (true) {
				const chunk = await reader.read()
				if (chunk.done) break
				totalBytes += chunk.value.byteLength
				if (totalBytes > maxBytes) {
					await reader.cancel().catch(() => undefined)
					throw new WarehouseResponseLimitError({
						kind: "bytes",
						message: `Raw SQL results may contain at most ${maxBytes} encoded bytes`,
					})
				}
				chunks.push(chunk.value)
			}
		} finally {
			reader.releaseLock()
		}

		const body = new Uint8Array(totalBytes)
		let offset = 0
		for (const chunk of chunks) {
			body.set(chunk, offset)
			offset += chunk.byteLength
		}
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	}

const createTinybirdSdkSqlClient = (
	config: TinybirdBackendConfig,
	requestFetch: typeof fetch = fetch,
): WarehouseSqlClient => {
	const makeClient = (fetchAdapter: typeof fetch = requestFetch) =>
		new Tinybird({
			baseUrl: config.host,
			token: config.token,
			datasources: {},
			pipes: {},
			devMode: false,
			fetch: fetchAdapter,
		})
	const client = makeClient()
	const boundedClients = new Map<number, typeof client>()
	return {
		sql: async (sql: string, options) => {
			try {
				// Tinybird Cloud currently defaults /v0/sql to JSON, while Tinybird Local
				// defaults to tab-separated output. The SDK always calls response.json(), so
				// make the expected wire format explicit for both environments. DSL-compiled
				// queries already end with `FORMAT JSON` (profile SETTINGS are inserted
				// before it by appendSettings) — appending a second FORMAT clause is a
				// ClickHouse syntax error, so only add one when the query doesn't carry
				// its own. The trailing-SETTINGS alternative covers SQL from callers that
				// still emit the legacy `FORMAT JSON SETTINGS …` order.
				const trimmed = sql.trimEnd().replace(/;$/, "")
				const hasFormat = /\bFORMAT\s+\w+(\s+SETTINGS\s[^\n]*)?$/i.test(trimmed)
				const jsonSql = hasFormat ? trimmed : `${trimmed}\nFORMAT JSON`
				const limits = options?.responseLimits
				// The SDK normally buffers through response.json(). Raw execution gets
				// a fetch adapter that aborts before constructing an oversized Response.
				let queryClient = client
				if (limits !== undefined) {
					queryClient =
						boundedClients.get(limits.maxBytes) ??
						makeClient(boundedResponseFetch(limits.maxBytes, requestFetch))
					boundedClients.set(limits.maxBytes, queryClient)
				}
				const result = await queryClient.sql<Record<string, unknown>>(jsonSql)
				if (limits !== undefined && result.data.length > limits.maxRows) {
					throw new WarehouseResponseLimitError({
						kind: "rows",
						message: `Raw SQL results may contain at most ${limits.maxRows} rows`,
					})
				}
				return { data: result.data }
			} catch (error) {
				// Empty 2xx body ⇒ zero rows. Return an empty result set so the caller's no-data path
				// runs instead of surfacing a spurious WarehouseClientError.
				if (isEmptyJsonBodyError(error)) return { data: [] }
				throw error
			}
		},
		insert: async (datasource, rows) => {
			if (rows.length === 0) return
			const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")
			const url = `${config.host.replace(/\/$/, "")}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`
			const response = await requestFetch(url, {
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

// Driver selection follows `BackendDialect[kind].driver`: the `tinybird` kind is
// the only one on the SDK; every ClickHouse-protocol kind (gateway, BYO/vanilla
// CH, chdb) uses the official web client.
const createClient = (config: ResolvedWarehouseConfig): WarehouseSqlClient =>
	config.kind === "tinybird" ? createTinybirdSdkSqlClient(config) : createClickHouseSqlClient(config)

let sqlClientFactory: typeof createClient = createClient

export class WarehouseQueryService extends Context.Service<
	WarehouseQueryService,
	WarehouseQueryServiceShape
>()("@maple/api/lib/WarehouseQueryService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const orgClickHouseSettings = yield* OrgClickHouseSettingsService
		const orgTokens = yield* TinybirdOrgTokenService

		// The managed (env-level) READ upstream: the Tinybird CH-gateway or vanilla
		// ClickHouse when CLICKHOUSE_URL is set, otherwise the managed Tinybird SDK.
		const resolveManagedConfig = Effect.fn("WarehouseQueryService.resolveManagedConfig")(function* () {
			if (Option.isSome(env.CLICKHOUSE_URL)) {
				const configuredUrl = env.CLICKHOUSE_URL.value
				const clickhouseUrl = yield* Effect.try({
					try: () => new URL(configuredUrl),
					catch: () =>
						new WarehouseConfigError({
							pipeName: "resolveManagedConfig",
							message: "CLICKHOUSE_URL is invalid",
						}),
				})
				if (clickhouseUrl.username.length > 0 || clickhouseUrl.password.length > 0) {
					return yield* new WarehouseConfigError({
						pipeName: "resolveManagedConfig",
						message: "CLICKHOUSE_URL must not contain embedded credentials",
					})
				}
				yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
				const kind =
					env.CLICKHOUSE_PROVIDER === "tinybird"
						? ("tinybird-gateway" as const)
						: ("clickhouse" as const)
				return {
					config: {
						kind,
						url: clickhouseUrl.toString().replace(/\/$/, ""),
						username: env.CLICKHOUSE_USER,
						password: Option.match(env.CLICKHOUSE_PASSWORD, {
							onNone: () =>
								kind === "tinybird-gateway" ? Redacted.value(env.TINYBIRD_TOKEN) : "",
							onSome: Redacted.value,
						}),
						database: env.CLICKHOUSE_DATABASE,
					},
					clientCacheKey: "read:managed",
				}
			}

			yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
			return {
				config: {
					kind: "tinybird" as const,
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
				},
				clientCacheKey: "read:managed",
			}
		})

		/**
		 * The single routing decision: purpose → backend + credentials.
		 *
		 *   ingest → managed Tinybird Events API, always            (source: managed)
		 *   read   → org BYO row? that org's ClickHouse             (source: org-byo)
		 *            else env: tinybird-gateway|clickhouse|tinybird (source: managed)
		 *   raw    → org BYO row? that org's ClickHouse             (source: org-byo)
		 *            managed tinybird/gateway? org-scoped JWT       (source: org-jwt)
		 *            managed vanilla CH? self-hosted mode only      (source: managed)
		 *
		 * Ingest notes (why writes NEVER follow the read routing):
		 * - BILLING: this path bypasses the ingest gateway, where Autumn usage
		 *   metering happens. Today's only `ingest` callers — demo seed, service-map
		 *   rollups, alert checks — are derived/internal/demo data and deliberately
		 *   unmetered. Net-new *customer* telemetry must go through the ingest
		 *   gateway (as the Cloudflare edge-metrics poller does) so it is metered.
		 * - When CLICKHOUSE_URL is set, the managed READ backend is a read-only
		 *   query gateway that rejects inserts ("Only SELECT or DESCRIBE queries
		 *   are supported. Got: InsertQuery"), and a per-org BYO override is a read
		 *   concern. Tinybird is the only writable warehouse (TINYBIRD_HOST/TOKEN
		 *   are required env). Routing writes anywhere else broke demo-seed
		 *   onboarding.
		 *
		 * Raw-SQL isolation invariants (defense-in-depth, preserved verbatim):
		 * BYO creds are already tenant-isolated; shared Tinybird gets a
		 * datasource-scoped org JWT (works through both the SDK and the CH
		 * gateway); a shared vanilla ClickHouse credential has no DB-enforced OrgId
		 * scope, so raw SQL there is allowed only in single-org self-hosted mode.
		 */
		const resolveRoute: WarehouseExecutorDeps["resolveRoute"] = Effect.fn(
			"WarehouseQueryService.resolveRoute",
		)(function* (tenant, purpose, label) {
			yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
			yield* Effect.annotateCurrentSpan("warehouse.route", purpose)

			if (purpose === "ingest") {
				// Legacy attrs, dual-emitted until dashboards move to `warehouse.*`.
				yield* Effect.annotateCurrentSpan("clientSource", "managed")
				yield* Effect.annotateCurrentSpan("query.routing", "ingest")
				yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
				return {
					source: "managed" as const,
					config: {
						kind: "tinybird" as const,
						host: env.TINYBIRD_HOST,
						token: Redacted.value(env.TINYBIRD_TOKEN),
					},
					clientCacheKey: "write:managed",
				}
			}

			// A per-org BYO ClickHouse row (`org_clickhouse_settings`) overrides the
			// managed upstream for that org's reads AND raw SQL (the credentials are
			// already tenant-isolated).
			const override = yield* orgClickHouseSettings
				.resolveRuntimeConfig(tenant.orgId)
				.pipe(Effect.mapError((error) => toWarehouseQueryError(label, error)))
			if (Option.isSome(override)) {
				yield* Effect.annotateCurrentSpan("clientSource", "org_override")
				yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
				return {
					source: "org-byo" as const,
					config: {
						kind: "clickhouse" as const,
						url: override.value.url,
						username: override.value.user,
						password: override.value.password,
						database: override.value.database,
					},
					clientCacheKey: purpose === "raw" ? `raw:${tenant.orgId}` : `read:${tenant.orgId}`,
				}
			}

			yield* Effect.annotateCurrentSpan("clientSource", "managed")
			const managed = yield* resolveManagedConfig()
			if (purpose === "read") return { source: "managed" as const, ...managed }

			// Raw SQL on the shared warehouse needs tenant isolation. Shared Tinybird
			// is isolated with a datasource-scoped JWT; the same token works through
			// both the SDK and Tinybird's ClickHouse-compatible gateway.
			const clientCacheKey = `raw:${tenant.orgId}`
			if (managed.config.kind === "tinybird" || managed.config.kind === "tinybird-gateway") {
				const jwt = yield* orgTokens.getOrgReadToken(tenant.orgId).pipe(
					Effect.mapError(
						(error) =>
							new WarehouseConfigError({
								pipeName: label,
								message: error.message,
								cause: error,
							}),
					),
				)
				yield* Effect.annotateCurrentSpan("maple.tinybird.token.scope", "org_jwt")
				return {
					source: "org-jwt" as const,
					config:
						managed.config.kind === "tinybird"
							? { ...managed.config, token: jwt }
							: { ...managed.config, password: jwt },
					clientCacheKey,
				}
			}

			// A shared vanilla ClickHouse credential has no database-enforced OrgId
			// scope. It is safe only in Maple's single-org self-hosted deployment mode.
			if (env.MAPLE_AUTH_MODE.toLowerCase() !== "self_hosted") {
				return yield* new WarehouseConfigError({
					pipeName: label,
					message:
						"Raw SQL on managed vanilla ClickHouse is available only in single-org self-hosted mode",
				})
			}
			return { source: "managed" as const, config: managed.config, clientCacheKey }
		})

		return makeWarehouseExecutor({
			createClient: (config) => sqlClientFactory(config),
			resolveRoute,
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
	boundedResponseFetch,
	isEmptyJsonBodyError,
}
