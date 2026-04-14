import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import {
  AlertDestinationInUseError,
  AlertForbiddenError,
  type AlertDestinationId,
  AlertRuleUpsertRequest,
  OrgId,
  RoleName,
  UserId,
} from "@maple/domain/http"
import type { TinybirdServiceShape } from "./TinybirdService"
import { TinybirdService } from "./TinybirdService"
import { AlertRuntime, type AlertRuntimeShape, AlertsService, type AlertsServiceShape } from "./AlertsService"
import { DatabaseLibsqlLive } from "./DatabaseLibsqlLive"
import { EdgeCacheService } from "./EdgeCacheService"
import { Env } from "./Env"
import { QueryEngineService } from "./QueryEngineService"

const createdTempDirs: string[] = []

afterEach(() => {
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

const makeConfig = (url: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      PORT: "3472",
      TINYBIRD_HOST: "https://maple-managed.tinybird.co",
      TINYBIRD_TOKEN: "managed-token",
      MAPLE_DB_URL: url,
      MAPLE_AUTH_MODE: "self_hosted",
      MAPLE_ROOT_PASSWORD: "test-root-password",
      MAPLE_DEFAULT_ORG_ID: "default",
      MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
      MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
      MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
    }),
  )

const emptyTinybirdRows = [] as ReadonlyArray<Record<string, unknown>>

function makeTinybirdStub(state: {
  tracesAggregateRows?: ReadonlyArray<Record<string, unknown>>
  metricsAggregateRows?: ReadonlyArray<Record<string, unknown>>
  logsAggregateRows?: ReadonlyArray<Record<string, unknown>>
  logsAggregateByServiceRows?: ReadonlyArray<Record<string, unknown>>
}): TinybirdServiceShape {
  const succeedRows = (rows: ReadonlyArray<Record<string, unknown>>) =>
    Effect.succeed(rows as never)

  // All alert queries now go through sqlQuery (raw SQL via CH query engine).
  // Route the response based on what data is configured in the test state.
  const sqlQueryStub = () => {
    // Return whichever data is configured — tests evaluate one rule type at a time
    if (state.logsAggregateByServiceRows?.length) return succeedRows(state.logsAggregateByServiceRows)
    if (state.tracesAggregateRows?.length) return succeedRows(state.tracesAggregateRows)
    if (state.metricsAggregateRows?.length) return succeedRows(state.metricsAggregateRows)
    if (state.logsAggregateRows?.length) return succeedRows(state.logsAggregateRows)
    return succeedRows(emptyTinybirdRows)
  }

  return {
    query: (_tenant, payload) =>
      Effect.fail(new Error(`Unexpected pipe ${payload.pipe}`)) as never,
    sqlQuery: sqlQueryStub,
  }
}

const defaultTestRuntime: AlertRuntimeShape = {
  now: () => Date.now(),
  makeUuid: () => crypto.randomUUID(),
  fetch: globalThis.fetch,
  deliveryTimeoutMs: () => 15_000,
}

const makeLayer = (url: string, tinybirdStub: TinybirdServiceShape, runtimeOverrides?: Partial<AlertRuntimeShape>) => {
  const configLive = makeConfig(url)
  const envLive = Env.Default.pipe(Layer.provide(configLive))
  const databaseLive = DatabaseLibsqlLive.pipe(Layer.provide(envLive))
  const tinybirdLive = Layer.succeed(TinybirdService, tinybirdStub)
  const queryEngineLive = QueryEngineService.layer.pipe(
    Layer.provide(tinybirdLive),
    Layer.provide(EdgeCacheService.layer),
  )
  const runtimeLive = Layer.succeed(AlertRuntime, { ...defaultTestRuntime, ...runtimeOverrides })

  return AlertsService.Live.pipe(
    Layer.provide(Layer.mergeAll(envLive, databaseLive, queryEngineLive, runtimeLive)),
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

const makeAdvancingClock = (): Pick<AlertRuntimeShape, "now"> => {
  let tick = Date.now()
  return {
    now: () => {
      const t = tick
      tick += 60_000
      return t
    },
  }
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
      serviceNames: ["checkout"],
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

const makeFixedClock = (timestamp: number): Pick<AlertRuntimeShape, "now"> => ({
  now: () => timestamp,
})

const makeUuidSequence = (...values: string[]): Pick<AlertRuntimeShape, "makeUuid"> => {
  let index = 0
  return {
    makeUuid: () =>
      values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }
}

const okFetch: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

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
    const fetchImpl = ((async (input: RequestInfo | URL, init?: RequestInit) => {
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
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state), { ...makeAdvancingClock(), fetch: fetchImpl }))),
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
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state), { ...makeAdvancingClock() }))),
    )

    expect(result.incidents.incidents).toHaveLength(0)
    expect(result.events.events).toHaveLength(0)
  })

  it("treats no data as a breach for throughput-below-threshold rules", async () => {
    const { url } = createTempDbUrl()
    const state = {
      tracesAggregateRows: emptyTinybirdRows,
    }

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
            serviceNames: ["checkout"],
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
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state), { ...makeAdvancingClock(), fetch: okFetch }))),
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
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state), { ...makeAdvancingClock(), fetch: okFetch }))),
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
    const fetchImpl = ((async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), { fetch: fetchImpl }))),
    )

    expect(response.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get("x-maple-event-type")).toBe("test")
    expect(requests[0]?.headers.get("x-maple-signature")).toBeTruthy()
    expect(requests[0]?.body).toContain("\"eventType\":\"test\"")
  })

  it("keeps processing queued deliveries when a rule evaluation fails", async () => {
    const fixedTime = 1_710_000_000_000
    const { url, dbPath } = createTempDbUrl()
    const requests: Array<{ headers: Headers }> = []
    const fetchImpl = ((async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers) })
      return new Response("ok", { status: 200 })
    }) as typeof fetch)
    const overrides = { ...makeFixedClock(fixedTime), fetch: fetchImpl }

    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_eval_failure")
        const userId = asUserId("user_eval_failure")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
        return { orgId, destination, rule }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), overrides))),
    )

    const db = new Database(dbPath)
    db.query("update alert_rules set query_spec_json = ? where id = ?").run("{", setup.rule.id)
    db.close()

    insertDeliveryEventRow(dbPath, {
      id: "00000000-0000-4000-8000-000000000101",
      orgId: setup.orgId,
      incidentId: null,
      ruleId: setup.rule.id,
      destinationId: setup.destination.id,
      deliveryKey: "manual-delivery-key",
      eventType: "test",
      attemptNumber: 1,
      status: "queued",
      scheduledAt: fixedTime - 1,
      payloadJson: JSON.stringify({
        eventType: "test",
        incidentId: null,
        incidentStatus: "resolved",
        dedupeKey: "manual-dedupe-key",
        rule: {
          id: setup.rule.id,
          name: setup.rule.name,
          signalType: setup.rule.signalType,
          severity: setup.rule.severity,
          groupKey: null,
          comparator: setup.rule.comparator,
          threshold: setup.rule.threshold,
          windowMinutes: setup.rule.windowMinutes,
        },
        observed: {
          value: 0,
          sampleCount: 0,
        },
        linkUrl: "http://127.0.0.1:3471/alerts",
        sentAt: new Date(fixedTime).toISOString(),
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const tick = yield* alerts.runSchedulerTick()
        const events = yield* alerts.listDeliveryEvents(setup.orgId)
        return { tick, events }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), overrides))),
    )

    expect(result.tick.evaluationFailureCount).toBe(1)
    expect(result.tick.processedCount).toBe(1)
    expect(result.tick.deliveryFailureCount).toBe(0)
    expect(requests).toHaveLength(1)
    expect(result.events.events[0]?.status).toBe("success")
  })

  it("suppresses duplicate delivery sends across concurrent service instances", async () => {
    const fixedTime = 1_710_000_100_000
    const { url, dbPath } = createTempDbUrl()
    let requestCount = 0
    const fetchImpl = ((async () => {
      requestCount += 1
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch)
    const overrides = { ...makeFixedClock(fixedTime), fetch: fetchImpl }

    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_dupe_guard")
        const userId = asUserId("user_dupe_guard")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
        return { orgId, destination, rule }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), overrides))),
    )

    const db = new Database(dbPath)
    db.query("update alert_rules set query_spec_json = ? where id = ?").run("{", setup.rule.id)
    db.close()

    insertDeliveryEventRow(dbPath, {
      id: "00000000-0000-4000-8000-000000000102",
      orgId: setup.orgId,
      incidentId: null,
      ruleId: setup.rule.id,
      destinationId: setup.destination.id,
      deliveryKey: "shared-delivery-key",
      eventType: "test",
      attemptNumber: 1,
      status: "queued",
      scheduledAt: fixedTime - 1,
      payloadJson: JSON.stringify({
        eventType: "test",
        incidentId: null,
        incidentStatus: "resolved",
        dedupeKey: "shared-dedupe-key",
        rule: {
          id: setup.rule.id,
          name: setup.rule.name,
          signalType: setup.rule.signalType,
          severity: setup.rule.severity,
          groupKey: null,
          comparator: setup.rule.comparator,
          threshold: setup.rule.threshold,
          windowMinutes: setup.rule.windowMinutes,
        },
        observed: {
          value: 0,
          sampleCount: 0,
        },
        linkUrl: "http://127.0.0.1:3471/alerts",
        sentAt: new Date(fixedTime).toISOString(),
      }),
    })

    const stub = makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows })
    const layerA = makeLayer(url, stub, overrides)
    const layerB = makeLayer(url, stub, overrides)

    const [tickA, tickB] = await Promise.all([
      Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertsService
          return yield* alerts.runSchedulerTick()
        }).pipe(Effect.provide(layerA)),
      ),
      Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertsService
          return yield* alerts.runSchedulerTick()
        }).pipe(Effect.provide(layerB)),
      ),
    ])

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        return yield* alerts.listDeliveryEvents(setup.orgId)
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows })))),
    )

    expect(requestCount).toBe(1)
    expect(tickA.processedCount + tickB.processedCount).toBe(1)
    expect(events.events.find((event) => event.deliveryKey === "shared-delivery-key")?.status).toBe("success")
  })

  it("skips duplicate delivery events and still creates the incident", async () => {
    const fixedTime = 1_710_000_200_000
    const { url, dbPath } = createTempDbUrl()

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
    const overrides = {
      ...makeFixedClock(fixedTime),
      ...makeUuidSequence(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
        "00000000-0000-4000-8000-000000000005",
      ),
      fetch: okFetch,
    }
    const layer = makeLayer(url, makeTinybirdStub(state), overrides)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_tx_rollback")
        const userId = asUserId("user_tx_rollback")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        const rule = yield* alerts.createRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "Immediate trigger",
            severity: "critical",
            enabled: true,
            serviceNames: ["checkout"],
            signalType: "error_rate",
            comparator: "gt",
            threshold: 5,
            windowMinutes: 5,
            minimumSampleCount: 10,
            consecutiveBreachesRequired: 1,
            consecutiveHealthyRequired: 1,
            renotifyIntervalMinutes: 30,
            destinationIds: [destination.id],
          }),
        )
        // Pre-insert a conflicting delivery event with the same delivery key
        // that processEvaluation will generate. With onConflictDoNothing(),
        // the duplicate insert is silently skipped and the incident is still created.
        yield* Effect.sync(() =>
          insertDeliveryEventRow(dbPath, {
            id: "00000000-0000-4000-8000-000000000099",
            orgId,
            incidentId: null,
            ruleId: rule.id,
            destinationId: destination.id,
            deliveryKey: `${"00000000-0000-4000-8000-000000000004"}:${destination.id}:trigger:${fixedTime}`,
            eventType: "trigger",
            attemptNumber: 1,
            status: "queued",
            scheduledAt: fixedTime + 60_000,
            payloadJson: JSON.stringify({
              eventType: "trigger",
              incidentId: null,
              incidentStatus: "resolved",
              dedupeKey: "conflict-dedupe",
              rule: {
                id: rule.id,
                name: rule.name,
                signalType: rule.signalType,
                severity: rule.severity,
                groupKey: null,
                comparator: rule.comparator,
                threshold: rule.threshold,
                windowMinutes: rule.windowMinutes,
              },
              observed: {
                value: 10,
                sampleCount: 200,
              },
              linkUrl: "http://127.0.0.1:3471/alerts",
              sentAt: new Date(fixedTime).toISOString(),
            }),
          }),
        )

        const tick = yield* alerts.runSchedulerTick()
        const incidents = yield* alerts.listIncidents(orgId)
        const events = yield* alerts.listDeliveryEvents(orgId)
        return { tick, incidents, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.tick.evaluationFailureCount).toBe(0)
    expect(result.incidents.incidents).toHaveLength(1)
    // Only the pre-existing event — the duplicate was silently skipped
    expect(result.events.events).toHaveLength(1)
    expect(result.events.events[0]?.deliveryKey).toContain(":trigger:")
  })

  it("times out stuck deliveries and enqueues a retry attempt", async () => {
    const fixedTime = 1_710_000_300_000
    const { url, dbPath } = createTempDbUrl()
    const hangingFetch = (() => new Promise(() => {})) as unknown as typeof fetch

    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_timeout")
        const userId = asUserId("user_timeout")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
        return { orgId, destination, rule }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), { ...makeFixedClock(fixedTime) }))),
    )

    insertDeliveryEventRow(dbPath, {
      id: "00000000-0000-4000-8000-000000000103",
      orgId: setup.orgId,
      incidentId: null,
      ruleId: setup.rule.id,
      destinationId: setup.destination.id,
      deliveryKey: "timeout-delivery-key",
      eventType: "test",
      attemptNumber: 1,
      status: "queued",
      scheduledAt: fixedTime - 1,
      payloadJson: JSON.stringify({
        eventType: "test",
        incidentId: null,
        incidentStatus: "resolved",
        dedupeKey: "timeout-dedupe-key",
        rule: {
          id: setup.rule.id,
          name: setup.rule.name,
          signalType: setup.rule.signalType,
          severity: setup.rule.severity,
          groupKey: null,
          comparator: setup.rule.comparator,
          threshold: setup.rule.threshold,
          windowMinutes: setup.rule.windowMinutes,
        },
        observed: {
          value: 0,
          sampleCount: 0,
        },
        linkUrl: "http://127.0.0.1:3471/alerts",
        sentAt: new Date(fixedTime).toISOString(),
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const tick = yield* alerts.runSchedulerTick()
        const events = yield* alerts.listDeliveryEvents(setup.orgId)
        return { tick, events }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), { ...makeFixedClock(fixedTime), fetch: hangingFetch, deliveryTimeoutMs: () => 10 }))),
    )

    expect(result.tick.processedCount).toBe(1)
    expect(result.tick.deliveryFailureCount).toBe(1)
    const timeoutEvent = result.events.events.find((event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 1)
    const retryEvent = result.events.events.find((event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 2)
    expect(timeoutEvent?.status).toBe("failed")
    expect(timeoutEvent?.errorMessage).toContain("timed out")
    expect(retryEvent?.status).toBe("queued")
  })

  it("marks corrupted queued payloads as failed without blocking later deliveries", async () => {
    const fixedTime = 1_710_000_400_000
    const { url, dbPath } = createTempDbUrl()
    let requestCount = 0
    const fetchImpl = ((async () => {
      requestCount += 1
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch)
    const overrides = { ...makeFixedClock(fixedTime), fetch: fetchImpl }

    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_payload_isolation")
        const userId = asUserId("user_payload_isolation")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)
        const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
        return { orgId, destination, rule }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), overrides))),
    )

    insertDeliveryEventRow(dbPath, {
      id: "00000000-0000-4000-8000-000000000104",
      orgId: setup.orgId,
      incidentId: null,
      ruleId: setup.rule.id,
      destinationId: setup.destination.id,
      deliveryKey: "bad-payload-key",
      eventType: "test",
      attemptNumber: 1,
      status: "queued",
      scheduledAt: fixedTime - 2,
      payloadJson: "{",
    })
    insertDeliveryEventRow(dbPath, {
      id: "00000000-0000-4000-8000-000000000105",
      orgId: setup.orgId,
      incidentId: null,
      ruleId: setup.rule.id,
      destinationId: setup.destination.id,
      deliveryKey: "good-payload-key",
      eventType: "test",
      attemptNumber: 1,
      status: "queued",
      scheduledAt: fixedTime - 1,
      payloadJson: JSON.stringify({
        eventType: "test",
        incidentId: null,
        incidentStatus: "resolved",
        dedupeKey: "good-payload-dedupe",
        rule: {
          id: setup.rule.id,
          name: setup.rule.name,
          signalType: setup.rule.signalType,
          severity: setup.rule.severity,
          groupKey: null,
          comparator: setup.rule.comparator,
          threshold: setup.rule.threshold,
          windowMinutes: setup.rule.windowMinutes,
        },
        observed: {
          value: 0,
          sampleCount: 0,
        },
        linkUrl: "http://127.0.0.1:3471/alerts",
        sentAt: new Date(fixedTime).toISOString(),
      }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const tick = yield* alerts.runSchedulerTick()
        const events = yield* alerts.listDeliveryEvents(setup.orgId)
        return { tick, events }
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }), overrides))),
    )

    expect(result.tick.processedCount).toBe(2)
    expect(result.tick.deliveryFailureCount).toBe(1)
    expect(requestCount).toBe(1)
    expect(result.events.events.find((event) => event.deliveryKey === "bad-payload-key")?.status).toBe("failed")
    expect(result.events.events.find((event) => event.deliveryKey === "good-payload-key")?.status).toBe("success")
  })

  it("evaluates logs query alerts in testRule without failing validation", async () => {
    const { url } = createTempDbUrl()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_logs_test")
        const userId = asUserId("user_logs_test")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        return yield* alerts.testRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "Checkout error logs",
            severity: "critical",
            enabled: true,
            signalType: "query",
            queryDataSource: "logs",
            queryAggregation: "count",
            queryWhereClause: 'service.name = "checkout" AND severity = "error"',
            comparator: "gt",
            threshold: 10,
            windowMinutes: 5,
            minimumSampleCount: 1,
            consecutiveBreachesRequired: 2,
            consecutiveHealthyRequired: 2,
            renotifyIntervalMinutes: 30,
            destinationIds: [destination.id],
          }),
        )
      }).pipe(
        Effect.provide(makeLayer(
          url,
          makeTinybirdStub({
            logsAggregateRows: [{ count: 42 }],
          }),
        )),
      ),
    )

    expect(result.status).toBe("breached")
    expect(result.value).toBe(42)
    expect(result.sampleCount).toBe(42)
  })

  it("rejects metrics alerts with multiple attr groupBy dimensions", async () => {
    const { url } = createTempDbUrl()

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_metrics_group_validation")
        const userId = asUserId("user_metrics_group_validation")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        return yield* alerts.createRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "Grouped metrics alert",
            severity: "warning",
            enabled: true,
            groupBy: ["attr.http.method", "attr.http.route"],
            signalType: "metric",
            comparator: "gt",
            threshold: 100,
            windowMinutes: 5,
            minimumSampleCount: 1,
            consecutiveBreachesRequired: 1,
            consecutiveHealthyRequired: 1,
            renotifyIntervalMinutes: 30,
            metricName: "http.server.request.duration",
            metricType: "histogram",
            metricAggregation: "avg",
            destinationIds: [destination.id],
          }),
        )
      }).pipe(
        Effect.provide(makeLayer(url, makeTinybirdStub({ metricsAggregateRows: emptyTinybirdRows }))),
      ),
    )

    const failure = getError(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toMatchObject({
      message: "Metrics alerts support at most one attr.* groupBy dimension",
    })
  })

  it("opens per-service incidents for grouped logs query alerts", async () => {
    const { url } = createTempDbUrl()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_logs_grouped")
        const userId = asUserId("user_logs_grouped")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        yield* alerts.createRule(
          orgId,
          userId,
          adminRoles,
          new AlertRuleUpsertRequest({
            name: "All services error logs",
            severity: "critical",
            enabled: true,
            signalType: "query",
            queryDataSource: "logs",
            queryAggregation: "count",
            queryWhereClause: 'severity = "error"',
            groupBy: ["service.name"],
            comparator: "gt",
            threshold: 10,
            windowMinutes: 5,
            minimumSampleCount: 1,
            consecutiveBreachesRequired: 2,
            consecutiveHealthyRequired: 2,
            renotifyIntervalMinutes: 30,
            destinationIds: [destination.id],
          }),
        )

        yield* alerts.runSchedulerTick()
        yield* alerts.runSchedulerTick()

        return yield* alerts.listIncidents(orgId)
      }).pipe(
        Effect.provide(makeLayer(
          url,
          makeTinybirdStub({
            logsAggregateByServiceRows: [
              { bucket: "2026-01-01 00:00:00", groupName: "svc-breach", count: 14 },
              { bucket: "2026-01-01 00:00:00", groupName: "svc-healthy", count: 3 },
            ],
          }),
          { ...makeAdvancingClock(), fetch: okFetch },
        )),
      ),
    )

    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0]?.groupKey).toBe("svc-breach")
    expect(result.incidents[0]?.status).toBe("open")
  })

  it("blocks destination deletion when rules still reference it", async () => {
    const { url } = createTempDbUrl()

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const alerts = yield* AlertsService
        const orgId = asOrgId("org_delete_guard")
        const userId = asUserId("user_delete_guard")
        const destination = yield* createWebhookDestination(alerts, orgId, userId)

        yield* createErrorRateRule(alerts, orgId, userId, destination.id)

        return yield* alerts.deleteDestination(orgId, adminRoles, destination.id)
      }).pipe(
        Effect.provide(makeLayer(url, makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }))),
      ),
    )

    const failure = getError(exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failure).toBeInstanceOf(AlertDestinationInUseError)
    expect(failure).toMatchObject({
      destinationId: expect.any(String),
      ruleNames: ["Checkout error rate"],
    })
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
      }).pipe(Effect.provide(makeLayer(url, makeTinybirdStub(state), { ...makeAdvancingClock(), fetch: okFetch }))),
    )

    expect(result.incidents).toHaveLength(2)
    const groupKeys = result.incidents.map((i: { groupKey: string | null }) => i.groupKey).sort()
    expect(groupKeys).toEqual(["svc-a", "svc-b"])
    expect(result.incidents.every((i: { status: string }) => i.status === "open")).toBe(true)
  })

  it("opens per-service incidents for groupBy=service rules", async () => {
    const { url } = createTempDbUrl()

    const breachingRow = {
      bucket: "2026-01-01 00:00:00",
      groupName: "svc-breach",
      count: 200,
      avgDuration: 40,
      p50Duration: 20,
      p95Duration: 120,
      p99Duration: 240,
      errorRate: 10,
      satisfiedCount: 180,
      toleratingCount: 10,
      apdexScore: 0.925,
      sampledSpanCount: 200,
      unsampledSpanCount: 0,
      dominantThreshold: "0",
    }
    const healthyRow = {
      bucket: "2026-01-01 00:00:00",
      groupName: "svc-healthy",
      count: 200,
      avgDuration: 20,
      p50Duration: 10,
      p95Duration: 80,
      p99Duration: 160,
      errorRate: 0.5,
      satisfiedCount: 195,
      toleratingCount: 3,
      apdexScore: 0.9825,
      sampledSpanCount: 200,
      unsampledSpanCount: 0,
      dominantThreshold: "0",
    }

    const stub: TinybirdServiceShape = {
      ...makeTinybirdStub({ tracesAggregateRows: emptyTinybirdRows }),
      sqlQuery: () =>
        Effect.succeed([breachingRow, healthyRow]) as never,
    }

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
            groupBy: ["service.name"],
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
      }).pipe(Effect.provide(makeLayer(url, stub, { ...makeAdvancingClock(), fetch: okFetch }))),
    )

    expect(result.incidents).toHaveLength(1)
    expect(result.incidents[0]?.groupKey).toBe("svc-breach")
    expect(result.incidents[0]?.status).toBe("open")
  })
})
