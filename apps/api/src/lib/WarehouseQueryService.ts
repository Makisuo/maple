import { createClient as createClickHouseClient } from "@clickhouse/client-web"
import { Tinybird } from "@tinybirdco/sdk"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { WarehouseConfigError, type WarehouseQueryRequest } from "@maple/domain/http"
import {
	makeWarehouseExecutor,
	toWarehouseQueryError,
	WarehouseResponseLimitError,
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
	(maxBytes: number): typeof fetch =>
	async (input, init) => {
		const response = await fetch(input, init)
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

const createTinybirdSdkSqlClient = (config: TinybirdConfig): WarehouseSqlClient => {
	const makeClient = (fetchAdapter?: typeof fetch) =>
		new Tinybird({
			baseUrl: config.host,
			token: config.token,
			datasources: {},
			pipes: {},
			devMode: false,
			...(fetchAdapter === undefined ? {} : { fetch: fetchAdapter }),
		})
	const client = makeClient()
	const boundedClients = new Map<number, typeof client>()
	return {
		sql: async (sql: string, options) => {
			try {
				// Tinybird Cloud currently defaults /v0/sql to JSON, while Tinybird Local
				// defaults to tab-separated output. The SDK always calls response.json(), so
				// make the expected wire format explicit for both environments.
				const jsonSql = `${sql.trimEnd().replace(/;$/, "")}\nFORMAT JSON`
				const limits = options?.responseLimits
				// The SDK normally buffers through response.json(). Raw execution gets
				// a fetch adapter that aborts before constructing an oversized Response.
				let queryClient = client
				if (limits !== undefined) {
					queryClient =
						boundedClients.get(limits.maxBytes) ??
						makeClient(boundedResponseFetch(limits.maxBytes))
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
		const orgTokens = yield* TinybirdOrgTokenService

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
				const provider: "tinybird" | "clickhouse" =
					env.CLICKHOUSE_PROVIDER === "tinybird" ? "tinybird" : "clickhouse"
				return {
					config: {
						_tag: "clickhouse" as const,
						provider,
						url: clickhouseUrl.toString().replace(/\/$/, ""),
						username: env.CLICKHOUSE_USER,
						password: Option.match(env.CLICKHOUSE_PASSWORD, {
							onNone: () => (provider === "tinybird" ? Redacted.value(env.TINYBIRD_TOKEN) : ""),
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
					_tag: "tinybird" as const,
					provider: "tinybird" as const,
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
				},
				clientCacheKey: "read:managed",
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
						provider: "clickhouse" as const,
						url: override.value.url,
						username: override.value.user,
						password: override.value.password,
						database: override.value.database,
					},
					clientCacheKey: `read:${tenant.orgId}`,
				}
			}

			yield* Effect.annotateCurrentSpan("clientSource", "managed")
			return yield* resolveManagedConfig()
		})

		const resolveRawSqlConfig: WarehouseExecutorDeps["resolveRawSqlConfig"] = Effect.fn(
			"WarehouseQueryService.resolveRawSqlConfig",
		)(function* (tenant, label) {
			const resolved = yield* resolveConfig(tenant, label)
			const clientCacheKey = `raw:${tenant.orgId}`

			// Per-org BYO ClickHouse credentials already isolate the warehouse.
			if (resolved.clientCacheKey !== "read:managed") {
				return { ...resolved, clientCacheKey }
			}

			// Shared Tinybird is isolated with a datasource-scoped JWT. The same token
			// works through both the SDK and Tinybird's ClickHouse-compatible gateway.
			if (resolved.config.provider === "tinybird") {
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
					config:
						resolved.config._tag === "tinybird"
							? { ...resolved.config, token: jwt }
							: { ...resolved.config, password: jwt },
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
			return { ...resolved, clientCacheKey }
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
		const resolveIngestConfig: NonNullable<WarehouseExecutorDeps["resolveIngestConfig"]> = Effect.fn(
			"WarehouseQueryService.resolveIngestConfig",
		)(function* (tenant, _label) {
			yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
			yield* Effect.annotateCurrentSpan("clientSource", "managed")
			yield* Effect.annotateCurrentSpan("query.routing", "ingest")
			yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
			return {
				config: {
					_tag: "tinybird" as const,
					provider: "tinybird" as const,
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
				},
				clientCacheKey: "write:managed",
			}
		})

		return makeWarehouseExecutor({
			createClient: (config) => sqlClientFactory(config),
			resolveConfig,
			resolveRawSqlConfig,
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
	boundedResponseFetch,
	isEmptyJsonBodyError,
}
