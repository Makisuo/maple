import {
  TinybirdQueryError,
  type TinybirdQueryRequest,
  TinybirdQueryResponse,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { Tinybird } from "@tinybirdco/sdk"
import { Effect, Layer, Option, Redacted, ServiceMap } from "effect"
import { Env } from "./Env"
import type { TenantContext } from "./AuthService"
import { OrgTinybirdSettingsService } from "./OrgTinybirdSettingsService"
import { compilePipeQuery } from "./PipeQueryDispatcher"

const CLIENT_CACHE_TTL_MS = 30_000
interface CachedClient {
  client: SqlClient
  host: string
  token: string
  expiresAt: number
}

export interface TinybirdServiceShape {
  readonly query: (
    tenant: TenantContext,
    payload: TinybirdQueryRequest,
  ) => Effect.Effect<TinybirdQueryResponse, TinybirdQueryError>
  readonly sqlQuery: (
    tenant: TenantContext,
    sql: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, TinybirdQueryError>
}

const clientCache = new Map<string, CachedClient>()

/** Minimal client interface — only raw SQL execution is needed now. */
interface SqlClient {
  readonly sql: (sql: string) => Promise<{ data: ReadonlyArray<Record<string, unknown>> }>
}

const createClient = (baseUrl: string, token: string): SqlClient => {
  const tb = new Tinybird({ baseUrl, token, datasources: {}, pipes: {} })
  return { sql: (sql: string) => tb.sql(sql) }
}

let tinybirdClientFactory: typeof createClient = createClient

export class TinybirdService extends ServiceMap.Service<TinybirdService, TinybirdServiceShape>()("TinybirdService", {
  make: Effect.gen(function* () {
    const env = yield* Env
    const orgTinybirdSettings = yield* OrgTinybirdSettingsService

    const toTinybirdQueryError = (pipe: string, error: unknown) =>
      new TinybirdQueryError({
        message: error instanceof Error ? error.message : "Tinybird query failed",
        pipe,
      })

    const getCachedOrCreateClient = (orgId: OrgId | "__managed__", host: string, token: string) => {
      const now = Date.now()
      const cached = clientCache.get(orgId)
      if (cached && cached.host === host && cached.token === token && cached.expiresAt > now) {
        return cached.client
      }
      const client = tinybirdClientFactory(host, token)
      clientCache.set(orgId, { client, host, token, expiresAt: now + CLIENT_CACHE_TTL_MS })
      return client
    }

    const resolveClient = Effect.fn("TinybirdService.resolveClient")(function* (
      tenant: TenantContext,
      pipe: string,
    ) {
      yield* Effect.annotateCurrentSpan("pipe", pipe)
      yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

      const override = yield* orgTinybirdSettings
        .resolveRuntimeConfig(tenant.orgId)
        .pipe(Effect.mapError((error) => toTinybirdQueryError(pipe, error)))

      if (Option.isSome(override)) {
        yield* Effect.annotateCurrentSpan("clientSource", "org_override")
        return getCachedOrCreateClient(tenant.orgId, override.value.host, override.value.token)
      }

      yield* Effect.annotateCurrentSpan("clientSource", "managed")
      return getCachedOrCreateClient("__managed__", env.TINYBIRD_HOST, Redacted.value(env.TINYBIRD_TOKEN))
    })

    const truncateSql = (s: string, maxLen = 1000) =>
      s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

    const executeSql = Effect.fn("TinybirdService.executeSql")(function* (
      tenant: TenantContext,
      sql: string,
      pipe: string,
    ) {
      yield* Effect.annotateCurrentSpan("db.system", "clickhouse")
      yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
      yield* Effect.annotateCurrentSpan("db.statement", truncateSql(sql))

      const client = yield* resolveClient(tenant, pipe)
      const result = yield* Effect.tryPromise({
        try: () => client.sql(sql),
        catch: (error) => toTinybirdQueryError(pipe, error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("TinybirdService.executeSql failed", { pipe, error: String(error) }),
        ),
      )

      yield* Effect.annotateCurrentSpan("result.rowCount", result.data.length)
      return result.data
    })

    const query = Effect.fn("TinybirdService.query")(function* (
      tenant: TenantContext,
      payload: TinybirdQueryRequest,
    ) {
      yield* Effect.annotateCurrentSpan("pipe", payload.pipe)
      yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

      if (!tenant.orgId || tenant.orgId.trim() === "") {
        return yield* new TinybirdQueryError({ pipe: payload.pipe, message: "org_id must not be empty" })
      }

      const compiled = compilePipeQuery(payload.pipe, {
        ...(payload.params ?? {}),
        org_id: tenant.orgId,
      })

      if (!compiled) {
        return yield* new TinybirdQueryError({
          message: `Unsupported pipe: ${payload.pipe}`,
          pipe: payload.pipe,
        })
      }

      const rows = yield* executeSql(tenant, compiled.sql, payload.pipe)

      return new TinybirdQueryResponse({
        data: Array.from(compiled.castRows(rows)),
      })
    })

    const sqlQuery = Effect.fn("TinybirdService.sqlQuery")(function* (
      tenant: TenantContext,
      sql: string,
    ) {
      if (!tenant.orgId || tenant.orgId.trim() === "") {
        return yield* new TinybirdQueryError({ pipe: "sqlQuery", message: "org_id must not be empty (sqlQuery)" })
      }
      if (!sql.includes("OrgId")) {
        return yield* new TinybirdQueryError({ pipe: "sqlQuery", message: "SQL query must contain OrgId filter (sqlQuery)" })
      }
      return yield* executeSql(tenant, sql, "sqlQuery")
    })

    return {
      query,
      sqlQuery,
    } satisfies TinybirdServiceShape
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer

  static readonly query = (
    tenant: TenantContext,
    payload: TinybirdQueryRequest,
  ) => this.use((service) => service.query(tenant, payload))
}

export const __testables = {
  setClientFactory: (factory: typeof createClient) => {
    tinybirdClientFactory = factory
    clientCache.clear()
  },
  reset: () => {
    tinybirdClientFactory = createClient
    clientCache.clear()
  },
}
