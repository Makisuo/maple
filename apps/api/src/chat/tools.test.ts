import { describe, expect, it } from "bun:test"
import {
  OrgId,
  RoleName,
  UserId,
} from "@maple/domain/http"
import { QueryEngineExecuteResponse } from "@maple/domain"
import { Effect, Option, Redacted, Schema } from "effect"
import { ApiKeysService } from "@/services/ApiKeysService"
import { AuthService } from "@/services/AuthService"
import { Env } from "@/services/Env"
import { QueryEngineService } from "@/services/QueryEngineService"
import { TinybirdService } from "@/services/TinybirdService"
import { executeQueryDataTool } from "./observability-tools"
import { buildChatToolExecutionLayer } from "./tools"

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeUserId = Schema.decodeUnknownSync(UserId)
const decodeRoleName = Schema.decodeUnknownSync(RoleName)

const tenant = {
  orgId: decodeOrgId("org_test"),
  userId: decodeUserId("user_test"),
  roles: [decodeRoleName("admin")],
  authMode: "clerk" as const,
}

const unexpectedTinybirdCall = () =>
  Effect.die(new Error("Tinybird should not be called by executeQueryDataTool"))

const envStub: typeof Env.Service = {
  PORT: 0,
  TINYBIRD_HOST: "https://tinybird.local",
  TINYBIRD_TOKEN: Redacted.make("token"),
  MAPLE_DB_URL: "",
  MAPLE_DB_AUTH_TOKEN: Option.none(),
  MAPLE_AUTH_MODE: "clerk",
  MAPLE_ROOT_PASSWORD: Option.none(),
  MAPLE_DEFAULT_ORG_ID: "default",
  MAPLE_INGEST_KEY_ENCRYPTION_KEY: Redacted.make("encrypt"),
  MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: Redacted.make("lookup"),
  MAPLE_INGEST_PUBLIC_URL: "http://localhost",
  CLERK_SECRET_KEY: Option.none(),
  CLERK_PUBLISHABLE_KEY: Option.none(),
  CLERK_JWT_KEY: Option.none(),
  MAPLE_ORG_ID_OVERRIDE: Option.none(),
  AUTUMN_SECRET_KEY: Option.none(),
  SD_INTERNAL_TOKEN: Option.none(),
  INTERNAL_SERVICE_TOKEN: Option.none(),
  OPENROUTER_API_KEY: Option.none(),
}

const authStub: typeof AuthService.Service = {
  resolveTenant: (_headers) => Effect.succeed(tenant),
  resolveMcpTenant: (_headers) => Effect.succeed(tenant),
  loginSelfHosted: (_password) =>
    Effect.die(new Error("loginSelfHosted should not be called in this test")),
}

const apiKeysStub: typeof ApiKeysService.Service = {
  list: (_orgId) => Effect.die(new Error("list should not be called in this test")),
  create: (_orgId, _userId, _params) =>
    Effect.die(new Error("create should not be called in this test")),
  revoke: (_orgId, _keyId) =>
    Effect.die(new Error("revoke should not be called in this test")),
  resolveByKey: (_apiKey) =>
    Effect.die(new Error("resolveByKey should not be called in this test")),
  touchLastUsed: (_keyId) =>
    Effect.die(new Error("touchLastUsed should not be called in this test")),
}

const tinybirdStub: typeof TinybirdService.Service = {
  query: (_tenant, _payload) => unexpectedTinybirdCall(),
  sql: (_tenant, _sql) => unexpectedTinybirdCall(),
  customTracesTimeseriesQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  customTracesBreakdownQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  customLogsTimeseriesQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  customLogsBreakdownQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  customMetricsBreakdownQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  metricTimeSeriesSumQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  metricTimeSeriesGaugeQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  metricTimeSeriesHistogramQuery: (_tenant, _params) => unexpectedTinybirdCall(),
  metricTimeSeriesExpHistogramQuery: (_tenant, _params) => unexpectedTinybirdCall(),
}

const queryEngineStub: typeof QueryEngineService.Service = {
  execute: (_tenant, _request) =>
    Effect.succeed(
      new QueryEngineExecuteResponse({
        result: {
          kind: "breakdown",
          source: "traces",
          data: [
            {
              name: "api",
              value: 42,
            },
          ],
        },
      }),
    ),
}

describe("buildChatToolExecutionLayer", () => {
  it("fully provides the shared query-data executor environment", async () => {
    const layer = buildChatToolExecutionLayer(
      { tenant, headers: {} },
      envStub,
      authStub,
      apiKeysStub,
      tinybirdStub,
      queryEngineStub,
    )

    const result = await Effect.runPromise(
      executeQueryDataTool({
        source: "traces",
        kind: "breakdown",
        group_by: "service",
        limit: 5,
      }).pipe(Effect.provide(layer)),
    )

    expect(result.tool).toBe("query_data")
    expect(result.data.result.kind).toBe("breakdown")
    expect(result.data.result.data).toEqual([
      {
        name: "api",
        value: 42,
      },
    ])
  })
})
