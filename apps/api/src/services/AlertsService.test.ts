import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  AlertForbiddenError,
  type AlertDestinationId,
  AlertRuleUpsertRequest,
  OrgId,
  RoleName,
  UserId,
} from "@maple/domain/http"
import type { TinybirdServiceShape } from "./TinybirdService"
import { TinybirdService } from "./TinybirdService"
import { AlertsService, type AlertsServiceShape, __testables } from "./AlertsService"
import { Database as DatabaseService } from "./DatabaseLive"
import { Env } from "./Env"
import { QueryEngineService } from "./QueryEngineService"

const createdTempDirs: string[] = []

afterEach(() => {
  __testables.reset()
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (!Exit.isFailure(exit)) return undefined

  const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (failure !== undefined) return failure

  return Cause.squash(exit.cause)
}

const createTempDbUrl = () => {
  const dir = mkdtempSync(join(tmpdir(), "maple-alerts-"))
  createdTempDirs.push(dir)

  const dbPath = join(dir, "maple.db")
  const db = new Database(dbPath)
  db.close()

  return { url: `file:${dbPath}`, dbPath }
}

const makeConfigProvider = (url: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://maple-managed.tinybird.co",
      TINYBIRD_TOKEN: "managed-token",
      MAPLE_DB_URL: url,
      MAPLE_DB_AUTH_TOKEN: "",
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
      MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
      MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
      CLERK_SECRET_KEY: "",
      CLERK_PUBLISHABLE_KEY: "",
      CLERK_JWT_KEY: "",
    }),
  )

const emptyTinybirdRows = [] as ReadonlyArray<Record<string, unknown>>

function makeTinybirdStub(state: {
  tracesAggregateRows?: ReadonlyArray<Record<string, unknown>>
  metricsAggregateRows?: ReadonlyArray<Record<string, unknown>>
}): TinybirdServiceShape {
  const succeedRows = (rows: ReadonlyArray<Record<string, unknown>>) =>
    Effect.succeed(rows as never)

  return {
    query: (_tenant, payload) =>
      Effect.fail(new Error(`Unexpected pipe ${payload.pipe}`)) as never,
    customTracesTimeseriesQuery: () => succeedRows(emptyTinybirdRows),
    customTracesBreakdownQuery: () => succeedRows(emptyTinybirdRows),
    customLogsTimeseriesQuery: () => succeedRows(emptyTinybirdRows),
    customLogsBreakdownQuery: () => succeedRows(emptyTinybirdRows),
    customMetricsBreakdownQuery: () => succeedRows(emptyTinybirdRows),
    metricTimeSeriesSumQuery: () => succeedRows(emptyTinybirdRows),
    metricTimeSeriesGaugeQuery: () => succeedRows(emptyTinybirdRows),
    metricTimeSeriesHistogramQuery: () => succeedRows(emptyTinybirdRows),
    metricTimeSeriesExpHistogramQuery: () => succeedRows(emptyTinybirdRows),
    alertTracesAggregateQuery: () =>
      succeedRows(state.tracesAggregateRows ?? emptyTinybirdRows),
    alertMetricsAggregateQuery: () =>
      succeedRows(state.metricsAggregateRows ?? emptyTinybirdRows),
    alertTracesAggregateByServiceQuery: () => succeedRows(emptyTinybirdRows),
    alertMetricsAggregateByServiceQuery: () => succeedRows(emptyTinybirdRows),
  }
}

const makeLayer = (url: string, tinybirdStub: TinybirdServiceShape) => {
  const configProvider = makeConfigProvider(url)
  const envLive = Env.Default.pipe(Layer.provide(configProvider))
  const databaseLive = DatabaseService.Default.pipe(Layer.provide(envLive))
  const tinybirdLive = Layer.succeed(TinybirdService, tinybirdStub)
  const queryEngineLive = QueryEngineService.layer.pipe(Layer.provide(tinybirdLive))

  return AlertsService.Live.pipe(
    Layer.provide(Layer.mergeAll(envLive, databaseLive, queryEngineLive)),
  ) as Layer.Layer<AlertsService, never, never>
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const adminRoles = [asRoleName("root")]
const memberRoles = [asRoleName("org:member")]

const createWebhookDestination = (
  alerts: AlertsServiceShape,
  orgId: ReturnType<typeof asOrgId>,
  userId: ReturnType<typeof asUserId>,
) =>
  alerts.createDestination(orgId, userId, adminRoles, {
    type: "webhook",
    name: "Primary webhook",
    enabled: true,
    url: "https://example.com/maple-alerts",
    signingSecret: "webhook-secret",
  })

const useAdvancingClock = () => {
  let tick = Date.now()
  __testables.setNow(() => {
    const t = tick
    tick += 60_000
    return t
  })
}

const createErrorRateRule = (
  alerts: AlertsServiceShape,
  orgId: ReturnType<typeof asOrgId>,
  userId: ReturnType<typeof asUserId>,
  destinationId: AlertDestinationId,
) =>
  alerts.createRule(
    orgId,
    userId,
    adminRoles,
    new AlertRuleUpsertRequest({
      name: "Checkout error rate",
      severity: "critical",
      enabled: true,
      serviceName: "checkout",
      signalType: "error_rate",
      comparator: "gt",
      threshold: 5,
      windowMinutes: 5,
      minimumSampleCount: 10,
      consecutiveBreachesRequired: 2,
      consecutiveHealthyRequired: 2,
      renotifyIntervalMinutes: 30,
      destinationIds: [destinationId],
    }),
  )

const useFixedClock = (timestamp: number) => {
  __testables.setNow(() => timestamp)
}

const useUuidSequence = (...values: string[]) => {
  let index = 0
  __testables.setRandomUuid(() => values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)
}

const insertDeliveryEventRow = (
  dbPath: string,
  row: {
    id: string
    orgId: string
    incidentId: string | null
    ruleId: string
    destinationId: string
    deliveryKey: string
    eventType: string
    attemptNumber: number
    status: string
    scheduledAt: number
    payloadJson: string
    createdAt?: number
    updatedAt?: number
  },
) => {
  const db = new Database(dbPath)
  db
    .query(`
      insert into alert_delivery_events (
        id,
        org_id,
        incident_id,
        rule_id,
        destination_id,
        delivery_key,
        event_type,
        attempt_number,
        status,
        scheduled_at,
        claimed_at,
        claim_expires_at,
        claimed_by,
        attempted_at,
        provider_message,
        provider_reference,
        response_code,
        error_message,
        payload_json,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, null, null, null, ?, ?, ?)
    `)
    .run(
      row.id,
      row.orgId,
      row.incidentId,
      row.ruleId,
      row.destinationId,
      row.deliveryKey,
      row.eventType,
      row.attemptNumber,
      row.status,
      row.scheduledAt,
      row.payloadJson,
      row.createdAt ?? row.scheduledAt,
      row.updatedAt ?? row.scheduledAt,
    )
  db.close()
}

describe("AlertsService", () => {
  it("opens an incident after consecutive breaches and delivers the webhook notification", async () => {
    useAdvancingClock()
    const { url } = createTempDbUrl()
    const state = {
      tracesAggregateRows: [
        {
          count: 200,
          avgDuration: 40,
          p50Duration: 20,
          p95Duration: 120,
          p99Duration: 240,
          errorRate: 10,
          satisfiedCount: 180,
          toleratingCount: 10,
          apdexScore: 0.925,
        },
      ],
    }
    const requests: Array<{ url: string; headers: Headers }> = []
    __testables.setFetchImpl((async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      })
      return new Response("ok", { status: 200 })
    }) as typeof fetch)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_alerts")
        const userId = asUserId("user_alerts")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        yield* createErrorRateRule(alerts, orgId, userId, destination.id)

        yield* alerts.runSchedulerTick()
        const incidentsAfterFirstTick = yield* alerts.listIncidents(orgId)

        yield* alerts.runSchedulerTick()
        const incidentsAfterSecondTick = yield* alerts.listIncidents(orgId)
        const events = yield* alerts.listDeliveryEvents(orgId)

        return { incidentsAfterFirstTick, incidentsAfterSecondTick, events }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state)))),
    )

    expect(result.incidentsAfterFirstTick.incidents).toHaveLength(0)
    expect(result.incidentsAfterSecondTick.incidents).toHaveLength(1)
    expect(result.incidentsAfterSecondTick.incidents[0]?.status).toBe("open")
    expect(result.events.events).toHaveLength(1)
    expect(result.events.events[0]?.status).toBe("success")
    expect(result.events.events[0]?.eventType).toBe("trigger")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://example.com/maple-alerts")
    expect(requests[0]?.headers.get("x-maple-signature")).toBeTruthy()
    expect(requests[0]?.headers.get("x-maple-event-type")).toBe("trigger")
    expect(requests[0]?.headers.get("x-maple-delivery-key")).toBe(
      result.events.events[0]?.deliveryKey,
    )
    expect(requests[0]?.headers.get("x-maple-delivery-key")).not.toBe(
      result.incidentsAfterSecondTick.incidents[0]?.dedupeKey,
    )
  })

  it("skips no-data error-rate rules instead of opening incidents", async () => {
    useAdvancingClock()
    const { url } = createTempDbUrl()
    const state = {
      tracesAggregateRows: emptyTinybirdRows,
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_skipped")
        const userId = asUserId("user_skipped")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        yield* createErrorRateRule(alerts, orgId, userId, destination.id)

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        const incidents = yield* alerts.listIncidents(orgId)
        const events = yield* alerts.listDeliveryEvents(orgId)
        return { incidents, events }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state)))),
    )

    expect(result.incidents.incidents).toHaveLength(0)
    expect(result.events.events).toHaveLength(0)
  })

  it("treats no data as a breach for throughput-below-threshold rules", async () => {
    useAdvancingClock()
    const { url } = createTempDbUrl()
    const state = {
      tracesAggregateRows: emptyTinybirdRows,
    }
    __testables.setFetchImpl((async () => new Response("ok", { status: 200 })) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_throughput")
        const userId = asUserId("user_throughput")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        yield* alerts.createRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "Zero throughput",
            severity: "warning",
            enabled: true,
            serviceName: "checkout",
            signalType: "throughput",
            comparator: "lt",
            threshold: 1,
            windowMinutes: 5,
            minimumSampleCount: 0,
            consecutiveBreachesRequired: 2,
            consecutiveHealthyRequired: 2,
            renotifyIntervalMinutes: 30,
            destinationIds: [destination.id],
          }),
        )

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        return yield* alerts.listIncidents(orgId)
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state)))),
    )

    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0]?.status).toBe("open")
    expect(result.incidents[0]?.signalType).toBe("throughput")
  })

  it("persists compiled query plans when rules are created", async () => {
    const { url, dbPath } = createTempDbUrl()

    await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_compiled_plan")
        const userId = asUserId("user_compiled_plan")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        yield* createErrorRateRule(alerts, orgId, userId, destination.id)
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows })))),
    )

    const db = new Database(dbPath, { readonly: true })
    const row = db
      .query(`
        select query_spec_json as querySpecJson, reducer, sample_count_strategy as sampleCountStrategy, no_data_behavior as noDataBehavior
        from alert_rules
        limit 1
      `)
      .get() as
      | {
          querySpecJson: string
          reducer: string
          sampleCountStrategy: string
          noDataBehavior: string
        }
      | undefined
    db.close()

    expect(row).toBeTruthy()
    expect(row?.reducer).toBe("identity")
    expect(row?.sampleCountStrategy).toBe("trace_count")
    expect(row?.noDataBehavior).toBe("skip")
    expect(JSON.parse(row?.querySpecJson ?? "{}")).toMatchObject({
      kind: "timeseries",
      source: "traces",
      metric: "error_rate",
      groupBy: ["none"],
      filters: {
        serviceName: "checkout",
      },
    })
  })

  it("resolves an open incident after consecutive healthy evaluations", async () => {
    useAdvancingClock()
    const { url } = createTempDbUrl()
    const state = {
      tracesAggregateRows: [
        {
          count: 200,
          avgDuration: 40,
          p50Duration: 20,
          p95Duration: 120,
          p99Duration: 240,
          errorRate: 10,
          satisfiedCount: 180,
          toleratingCount: 10,
          apdexScore: 0.925,
        },
      ] as ReadonlyArray<Record<string, unknown>>,
    }
    __testables.setFetchImpl((async () => new Response("ok", { status: 200 })) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_resolve")
        const userId = asUserId("user_resolve")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        yield* createErrorRateRule(alerts, orgId, userId, destination.id)

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        state.tracesAggregateRows = [
          {
            count: 200,
            avgDuration: 20,
            p50Duration: 10,
            p95Duration: 80,
            p99Duration: 160,
            errorRate: 0.5,
            satisfiedCount: 195,
            toleratingCount: 3,
            apdexScore: 0.9825,
          },
        ]

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        const incidents = yield* alerts.listIncidents(orgId)
        const events = yield* alerts.listDeliveryEvents(orgId)
        return { incidents, events }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state)))),
    )

    expect(result.incidents.incidents).toHaveLength(1)
    expect(result.incidents.incidents[0]?.status).toBe("resolved")
    expect(result.events.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "resolve",
      "trigger",
    ])
  })

  it("sends signed webhook test notifications", async () => {
    const { url } = createTempDbUrl()
    const requests: Array<{ headers: Headers; body: string }> = []
    __testables.setFetchImpl((async (_input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      })
      return new Response("ok", { status: 200 })
    }) as typeof fetch)

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_test_destination")
        const userId = asUserId("user_test_destination")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        return yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows })))),
    )

    expect(response.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get("x-maple-event-type")).toBe("test")
    expect(requests[0]?.headers.get("x-maple-signature")).toBeTruthy()
    expect(requests[0]?.body).toContain("\"eventType\":\"test\"")
  })

  it("rejects destination creation for non-admin members", async () => {
    const { url } = createTempDbUrl()

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        return yield* alerts.createDestination(
          asOrgId("org_forbidden"),
          asUserId("user_forbidden"),
          memberRoles,
          {
            type: "webhook",
            name: "Member webhook",
            enabled: true,
            url: "https://example.com/member",
          },
        )
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows })))),
    )

    const failure = getError(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toBeInstanceOf(AlertForbiddenError)
  })

  it("opens per-service incidents for multi-service rules", async () => {
    useAdvancingClock()
    const { url } = createTempDbUrl()
    const state = {
      tracesAggregateRows: [
        {
          count: 200,
          avgDuration: 40,
          p50Duration: 20,
          p95Duration: 120,
          p99Duration: 240,
          errorRate: 10,
          satisfiedCount: 180,
          toleratingCount: 10,
          apdexScore: 0.925,
        },
      ],
    }
    __testables.setFetchImpl((async () => new Response("ok", { status: 200 })) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_multi_svc")
        const userId = asUserId("user_multi_svc")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        yield* alerts.createRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "Multi-service error rate",
            severity: "critical",
            enabled: true,
            serviceNames: ["svc-a", "svc-b"],
            signalType: "error_rate",
            comparator: "gt",
            threshold: 5,
            windowMinutes: 5,
            minimumSampleCount: 10,
            consecutiveBreachesRequired: 2,
            consecutiveHealthyRequired: 2,
            renotifyIntervalMinutes: 30,
            destinationIds: [destination.id],
          }),
        )

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        return yield* alerts.listIncidents(orgId)
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state)))),
    )

    expect(result.incidents).toHaveLength(2)
    const serviceNames = result.incidents.map((i: { serviceName: string | null }) => i.serviceName).sort()
    expect(serviceNames).toEqual(["svc-a", "svc-b"])
    expect(result.incidents.every((i: { status: string }) => i.status === "open")).toBe(true)
  })

  it("opens per-service incidents for groupBy=service rules", async () => {
    useAdvancingClock()
    const { url } = createTempDbUrl()

    const breachingRow = {
      serviceName: "svc-breach",
      count: 200,
      avgDuration: 40,
      p50Duration: 20,
      p95Duration: 120,
      p99Duration: 240,
      errorRate: 10,
      satisfiedCount: 180,
      toleratingCount: 10,
      apdexScore: 0.925,
    }
    const healthyRow = {
      serviceName: "svc-healthy",
      count: 200,
      avgDuration: 20,
      p50Duration: 10,
      p95Duration: 80,
      p99Duration: 160,
      errorRate: 0.5,
      satisfiedCount: 195,
      toleratingCount: 3,
      apdexScore: 0.9825,
    }

    const stub = makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows })
    stub.alertTracesAggregateByServiceQuery = () =>
      Effect.succeed([breachingRow, healthyRow]) as never

    __testables.setFetchImpl((async () => new Response("ok", { status: 200 })) as unknown as typeof fetch)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_grouped")
        const userId = asUserId("user_grouped")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        yield* alerts.createRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "All services error rate",
            severity: "critical",
            enabled: true,
            groupBy: "service",
            signalType: "error_rate",
            comparator: "gt",
            threshold: 5,
            windowMinutes: 5,
            minimumSampleCount: 10,
            consecutiveBreachesRequired: 2,
            consecutiveHealthyRequired: 2,
            renotifyIntervalMinutes: 30,
            destinationIds: [destination.id],
          }),
        )

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        return yield* alerts.listIncidents(orgId)
      }).pipe(Effect.provide(makeLayer(url, stub))),
    )

    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0]?.serviceName).toBe("svc-breach")
    expect(result.incidents[0]?.status).toBe("open")
  })
})
