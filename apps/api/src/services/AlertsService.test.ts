import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, Clock, ConfigProvider, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	AlertDestinationInUseError,
	AlertForbiddenError,
	AlertValidationError,
	type AlertDestinationId,
	AlertRulePreviewRequest,
	AlertRuleUpsertRequest,
	OrgId,
	WarehouseQueryError,
	RoleName,
	UserId,
} from "@maple/domain/http"
import type { WarehouseQueryServiceShape } from "../lib/WarehouseQueryService"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { AlertRuntime, type AlertRuntimeShape, AlertsService, type AlertsServiceShape } from "./AlertsService"
import { BucketCacheService, EdgeCacheService } from "@maple/query-engine/caching"
import { CacheBackendLive } from "../lib/CacheBackendLive"
import { Env } from "../lib/Env"
import { HazelOAuthService } from "./HazelOAuthService"
import { QueryEngineService } from "./QueryEngineService"
import { cleanupTestDbs, createTestDb, executeSql, queryFirstRow, type TestDb } from "../lib/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
			QE_EVAL_BUCKET_CACHE_ENABLED: "false",
		}),
	)

const emptyWarehouseRows: ReadonlyArray<Record<string, unknown>> = []

function makeWarehouseStub(state: {
	tracesAggregateRows?: ReadonlyArray<Record<string, unknown>>
	metricsAggregateRows?: ReadonlyArray<Record<string, unknown>>
	logsAggregateRows?: ReadonlyArray<Record<string, unknown>>
	logsAggregateByServiceRows?: ReadonlyArray<Record<string, unknown>>
	rawQueryRows?: ReadonlyArray<Record<string, unknown>>
}): WarehouseQueryServiceShape {
	const succeedRows = (rows: ReadonlyArray<Record<string, unknown>>) => Effect.succeed(rows)

	// All alert queries now go through sqlQuery (raw SQL via CH query engine).
	// Route the response based on what data is configured in the test state.
	const sqlQueryStub = () => {
		// Return whichever data is configured — tests evaluate one rule type at a time
		if (state.rawQueryRows?.length) return succeedRows(state.rawQueryRows)
		if (state.logsAggregateByServiceRows?.length) return succeedRows(state.logsAggregateByServiceRows)
		if (state.tracesAggregateRows?.length) return succeedRows(state.tracesAggregateRows)
		if (state.metricsAggregateRows?.length) return succeedRows(state.metricsAggregateRows)
		if (state.logsAggregateRows?.length) return succeedRows(state.logsAggregateRows)
		return succeedRows(emptyWarehouseRows)
	}

	return {
		query: (_tenant, payload) => Effect.die(new Error(`Unexpected pipe ${payload.pipeName}`)),
		sqlQuery: sqlQueryStub,
		compiledQuery: (_tenant, compiled) =>
			sqlQueryStub().pipe(Effect.flatMap((rows) => compiled.decodeRows(rows).pipe(Effect.orDie))),
		compiledQueryFirst: (_tenant, compiled) =>
			sqlQueryStub().pipe(Effect.flatMap((rows) => compiled.decodeFirstRow(rows).pipe(Effect.orDie))),
		ingest: () => Effect.void,
		asExecutor: () => {
			throw new Error("asExecutor is not supported by this test stub")
		},
	}
}

const defaultTestRuntime: AlertRuntimeShape = {
	// Time is sourced from Effect's Clock, which `it.effect` swaps for TestClock —
	// scheduler-timestamp tests drive it deterministically via TestClock.setTime /
	// TestClock.adjust. Real `fetch`/`Effect.timeout` settle on the live event loop.
	now: Clock.currentTimeMillis,
	makeUuid: () => crypto.randomUUID(),
	fetch: globalThis.fetch,
	deliveryTimeoutMs: () => 15_000,
}

// The fixed epoch scheduler tests start TestClock at, mirroring the previous
// manual clock's default start time.
const DEFAULT_CLOCK_EPOCH_MS = 1_700_000_000_000

const makeLayer = (
	testDb: TestDb,
	warehouseStub: WarehouseQueryServiceShape,
	runtimeOverrides?: Partial<AlertRuntimeShape>,
) => {
	const configLive = makeConfig()
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = testDb.layer
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseStub)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const bucketCacheLive = BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))
	const queryEngineLive = QueryEngineService.layer.pipe(
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(bucketCacheLive),
		// Wire the test config so QE_EVAL_BUCKET_CACHE_ENABLED=false reaches
		// QueryEngineService. These alert-logic stubs return aggregate-shaped rows
		// (no per-bucket timestamps), which the bucket-cached evaluate path can't
		// bucket; keep alerts on the blob path. (Bucket path: QueryEngineEvaluateCache.test.ts.)
		Layer.provide(configLive),
	)
	const runtimeLive = Layer.succeed(AlertRuntime, { ...defaultTestRuntime, ...runtimeOverrides })
	const hazelOAuthLive = HazelOAuthService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, databaseLive)))

	return AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				envLive,
				databaseLive,
				queryEngineLive,
				warehouseLive,
				runtimeLive,
				hazelOAuthLive,
			),
		),
	)
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

const makeUuidSequence = (...values: string[]): Pick<AlertRuntimeShape, "makeUuid"> => {
	let index = 0
	return {
		makeUuid: () => values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	}
}

const okFetch: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

const insertDeliveryEventRow = async (
	db: TestDb,
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
	await executeSql(
		db,
		`
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
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null, null, null, null, null, null, null, null, $11::jsonb, $12, $13)
    `,
		[
			row.id,
			row.orgId,
			row.incidentId,
			row.ruleId,
			row.destinationId,
			row.deliveryKey,
			row.eventType,
			row.attemptNumber,
			row.status,
			new Date(row.scheduledAt),
			row.payloadJson,
			new Date(row.createdAt ?? row.scheduledAt),
			new Date(row.updatedAt ?? row.scheduledAt),
		],
	)
}

describe("AlertsService", () => {
	it.effect("opens an incident after consecutive breaches and delivers the webhook notification", () => {
		const testDb = createTestDb(trackedDbs)
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
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts")
			const userId = asUserId("user_alerts")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			const incidentsAfterFirstTick = yield* alerts.listIncidents(orgId)

			// Advance past the scheduler lock TTL so the rule can be claimed again.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const incidentsAfterSecondTick = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidentsAfterFirstTick.incidents, 0)
			assert.lengthOf(incidentsAfterSecondTick.incidents, 1)
			assert.strictEqual(incidentsAfterSecondTick.incidents[0]?.status, "open")
			assert.lengthOf(events.events, 1)
			assert.strictEqual(events.events[0]?.status, "success")
			assert.strictEqual(events.events[0]?.eventType, "trigger")
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.url, "https://example.com/maple-alerts")
			assert.isNotEmpty(requests[0]?.headers.get("x-maple-signature") ?? "")
			assert.strictEqual(requests[0]?.headers.get("x-maple-event-type"), "trigger")
			assert.strictEqual(requests[0]?.headers.get("x-maple-delivery-key"), events.events[0]?.deliveryKey)
			assert.notStrictEqual(
				requests[0]?.headers.get("x-maple-delivery-key"),
				incidentsAfterSecondTick.incidents[0]?.dedupeKey,
			)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })),
		)
	})

	it.effect("snapshots a custom notification template into the delivered payload", () => {
		const testDb = createTestDb(trackedDbs)
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
		const bodies: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? init.body : "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_tpl")
			const userId = asUserId("user_tpl")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
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
					destinationIds: [destination.id],
					notificationTemplate: {
						title: "{{ severity }} on {{ rule.name }}",
						body: "*Observed:* {{ observed.summary }}",
					},
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// The custom template is re-read from the rule and surfaces through
			// get_alert_rule / listRules.
			const rules = yield* alerts.listRules(orgId)
			assert.strictEqual(rules.rules[0]?.notificationTemplate?.title, "{{ severity }} on {{ rule.name }}")

			// The webhook body is the snapshotted delivery payload — it carries the
			// template so retries and downstream consumers render the same message.
			assert.lengthOf(bodies, 1)
			const payload = JSON.parse(bodies[0]!) as {
				template?: { title?: string; body?: string }
			}
			assert.strictEqual(payload.template?.title, "{{ severity }} on {{ rule.name }}")
			assert.strictEqual(payload.template?.body, "*Observed:* {{ observed.summary }}")
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })),
		)
	})

	it.effect("skips no-data error-rate rules instead of opening incidents", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_skipped")
			const userId = asUserId("user_skipped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 0)
			assert.lengthOf(events.events, 0)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state))))
	})

	it.effect("treats no data as a breach for throughput-below-threshold rules", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
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
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			assert.strictEqual(incidents.incidents[0]?.signalType, "throughput")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("persists compiled query plans when rules are created", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_compiled_plan")
			const userId = asUserId("user_compiled_plan")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					querySpecJson: unknown
					reducer: string
					sampleCountStrategy: string
					noDataBehavior: string
				}>(
					testDb,
					`
        select query_spec_json as "querySpecJson", reducer, sample_count_strategy as "sampleCountStrategy", no_data_behavior as "noDataBehavior"
        from alert_rules
        limit 1
      `,
				),
			)

			assert.isOk(row)
			assert.strictEqual(row?.reducer, "identity")
			assert.strictEqual(row?.sampleCountStrategy, "trace_count")
			assert.strictEqual(row?.noDataBehavior, "skip")
			const spec = row?.querySpecJson as {
				kind: string
				source: string
				metric: string
				groupBy: ReadonlyArray<string>
				filters: { serviceName: string }
			}
			assert.strictEqual(spec.kind, "timeseries")
			assert.strictEqual(spec.source, "traces")
			assert.strictEqual(spec.metric, "error_rate")
			assert.deepStrictEqual(spec.groupBy, ["none"])
			assert.strictEqual(spec.filters.serviceName, "checkout")
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("resolves an open incident after consecutive healthy evaluations", () => {
		const testDb = createTestDb(trackedDbs)
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

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_resolve")
			const userId = asUserId("user_resolve")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
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

			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "resolved")
			assert.deepStrictEqual(events.events.map((event: { eventType: string }) => event.eventType), [
				"resolve",
				"trigger",
			])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("skips unchanged alert_rule_states writes and refreshes on the 5-minute heartbeat", () => {
		const testDb = createTestDb(trackedDbs)
		// Healthy from the start: errorRate 1 stays below the threshold of 5.
		const state = {
			tracesAggregateRows: [
				{
					count: 200,
					avgDuration: 20,
					p50Duration: 10,
					p95Duration: 80,
					p99Duration: 160,
					errorRate: 1,
					satisfiedCount: 195,
					toleratingCount: 3,
					apdexScore: 0.9825,
				},
			] as ReadonlyArray<Record<string, unknown>>,
		}

		const readState = (ruleId: string) =>
			Effect.promise(() =>
				queryFirstRow<{
					consecutive_healthy: number
					consecutive_breaches: number
					last_status: string | null
					last_evaluated_at: Date | string
					updated_at: Date | string
				}>(
					testDb,
					`select consecutive_healthy, consecutive_breaches, last_status, last_evaluated_at, updated_at
					 from alert_rule_states where rule_id = $1 and group_key = '__total__'`,
					[ruleId],
				),
			)
		const ms = (value: Date | string | undefined) => new Date(value ?? 0).getTime()

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_quiet")
			const userId = asUserId("user_state_quiet")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Tick 1 (T+0): healthy=1 → writes. Tick 2 (T+1m): healthy=2 (capped at
			// consecutiveHealthyRequired) → writes.
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterSecondTick = yield* readState(rule.id)
			assert.strictEqual(afterSecondTick?.consecutive_healthy, 2)
			assert.strictEqual(afterSecondTick?.last_status, "healthy")
			assert.strictEqual(ms(afterSecondTick?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			// Ticks at T+2m..T+5m: state unchanged and within the heartbeat window
			// (last write T+1m) → the upsert is skipped, the row stays byte-identical.
			for (let i = 0; i < 4; i++) {
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
			}
			const afterQuietTicks = yield* readState(rule.id)
			assert.strictEqual(afterQuietTicks?.consecutive_healthy, 2)
			assert.strictEqual(ms(afterQuietTicks?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)
			assert.strictEqual(ms(afterQuietTicks?.updated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			// Tick at T+6m: 5 minutes since the last write → heartbeat refreshes
			// last_evaluated_at without changing the state.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterHeartbeat = yield* readState(rule.id)
			assert.strictEqual(afterHeartbeat?.consecutive_healthy, 2)
			assert.strictEqual(afterHeartbeat?.last_status, "healthy")
			assert.strictEqual(ms(afterHeartbeat?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 6 * 60_000)

			// A transition writes immediately, even right after a heartbeat write:
			// flip the warehouse to breaching and tick at T+7m.
			state.tracesAggregateRows = [
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
			]
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterBreach = yield* readState(rule.id)
			assert.strictEqual(afterBreach?.last_status, "breached")
			assert.strictEqual(afterBreach?.consecutive_breaches, 1)
			assert.strictEqual(afterBreach?.consecutive_healthy, 0)
			assert.strictEqual(ms(afterBreach?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 7 * 60_000)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("caps the breach counter during an open incident while the incident row keeps updating", () => {
		const testDb = createTestDb(trackedDbs)
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

		const ms = (value: Date | string | undefined) => new Date(value ?? 0).getTime()

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_cap")
			const userId = asUserId("user_state_cap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Two breach ticks open the incident (consecutiveBreachesRequired: 2).
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// Two more breach ticks: the counter saturates at 2, so the state row goes
			// quiet while the incident row keeps tracking the ongoing breach.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const stateRow = yield* Effect.promise(() =>
				queryFirstRow<{ consecutive_breaches: number; updated_at: Date | string }>(
					testDb,
					`select consecutive_breaches, updated_at from alert_rule_states
					 where rule_id = $1 and group_key = '__total__'`,
					[rule.id],
				),
			)
			assert.strictEqual(stateRow?.consecutive_breaches, 2)
			// Last state write was the tick that reached the cap (T+1m).
			assert.strictEqual(ms(stateRow?.updated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			const incidentRow = yield* Effect.promise(() =>
				queryFirstRow<{ status: string; last_evaluated_at: Date | string }>(
					testDb,
					`select status, last_evaluated_at from alert_incidents where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(incidentRow?.status, "open")
			assert.strictEqual(ms(incidentRow?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 3 * 60_000)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("sends signed webhook test notifications", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers; body: string }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				headers: new Headers(init?.headers),
				body: String(init?.body ?? ""),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_test_destination")
			const userId = asUserId("user_test_destination")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const response = yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)

			assert.isTrue(response.success)
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.headers.get("x-maple-event-type"), "test")
			assert.isNotEmpty(requests[0]?.headers.get("x-maple-signature") ?? "")
			assert.include(requests[0]?.body ?? "", '"eventType":"test"')
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("keeps processing queued deliveries when a rule evaluation fails", () => {
		const fixedTime = 1_710_000_000_000
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ headers: new Headers(init?.headers) })
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			// Pin the clock to fixedTime so the pre-seeded delivery (scheduledAt: fixedTime - 1) is due.
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_eval_failure")
			const userId = asUserId("user_eval_failure")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", ["{}", rule.id]),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000101",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
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
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.evaluationFailureCount, 1)
			assert.strictEqual(tick.processedCount, 1)
			assert.strictEqual(tick.deliveryFailureCount, 0)
			assert.lengthOf(requests, 1)
			assert.strictEqual(events.events[0]?.status, "success")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("suppresses duplicate delivery sends across concurrent service instances", () => {
		const fixedTime = 1_710_000_100_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as unknown as typeof fetch

		const stub = makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })
		const overrides = { fetch: fetchImpl }

		return Effect.gen(function* () {
			// One shared TestClock pinned to fixedTime backs every service instance below.
			yield* TestClock.setTime(fixedTime)
			const setup = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dupe_guard")
				const userId = asUserId("user_dupe_guard")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				return { orgId, destination, rule }
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					setup.rule.id,
				]),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
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
				}),
			)

			// Two independent service instances race to claim the same queued delivery;
			// the DB-level claim lease must let exactly one of them send it.
			const runTick = Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.runSchedulerTick()
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			const [tickA, tickB] = yield* Effect.all([runTick, runTick], {
				concurrency: "unbounded",
			})

			const events = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.listDeliveryEvents(setup.orgId)
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			assert.strictEqual(requestCount, 1)
			assert.strictEqual(tickA.processedCount + tickB.processedCount, 1)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "shared-delivery-key")?.status,
				"success",
			)
		})
	})

	it.effect("skips duplicate delivery events and still creates the incident", () => {
		const fixedTime = 1_710_000_200_000
		const testDb = createTestDb(trackedDbs)

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
			...makeUuidSequence(
				"00000000-0000-4000-8000-000000000001",
				"00000000-0000-4000-8000-000000000002",
				"00000000-0000-4000-8000-000000000003",
				"00000000-0000-4000-8000-000000000004",
				"00000000-0000-4000-8000-000000000005",
			),
			fetch: okFetch,
		}
		const layer = makeLayer(testDb, makeWarehouseStub(state), overrides)

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
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
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
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

			assert.strictEqual(tick.evaluationFailureCount, 0)
			assert.lengthOf(incidents.incidents, 1)
			// Only the pre-existing event — the duplicate was silently skipped
			assert.lengthOf(events.events, 1)
			assert.include(events.events[0]?.deliveryKey ?? "", ":trigger:")
		}).pipe(Effect.provide(layer))
	})

	it.live("times out stuck deliveries and enqueues a retry attempt", () => {
		const fixedTime = 1_710_000_300_000
		const testDb = createTestDb(trackedDbs)
		const hangingFetch = (() => new Promise(() => {})) as unknown as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_timeout")
			const userId = asUserId("user_timeout")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000103",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
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
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			// The dispatch wraps the hanging fetch in a 10ms timeout driven by the
			// live runtime clock, so the timeout fires on its own in real time.
			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.processedCount, 1)
			assert.strictEqual(tick.deliveryFailureCount, 1)
			const timeoutEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 1,
			)
			const retryEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 2,
			)
			assert.strictEqual(timeoutEvent?.status, "failed")
			assert.include(timeoutEvent?.errorMessage ?? "", "timed out")
			assert.strictEqual(retryEvent?.status, "queued")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					now: Effect.succeed(fixedTime),
					fetch: hangingFetch,
					deliveryTimeoutMs: () => 10,
				}),
			),
		)
	})

	it.effect("marks corrupted queued payloads as failed without blocking later deliveries", () => {
		const fixedTime = 1_710_000_400_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as unknown as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_payload_isolation")
			const userId = asUserId("user_payload_isolation")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000104",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "bad-payload-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 2,
					// jsonb can only hold valid JSON, so "corrupted" now means a stored
					// payload that fails the delivery-payload schema decode (every field
					// is optional, so it must be present-but-mistyped).
					payloadJson: JSON.stringify({ eventType: 123 }),
				}),
			)
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000105",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
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
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.processedCount, 2)
			assert.strictEqual(tick.deliveryFailureCount, 1)
			assert.strictEqual(requestCount, 1)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "bad-payload-key")?.status,
				"failed",
			)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "good-payload-key")?.status,
				"success",
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("evaluates logs query alerts in testRule without failing validation", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
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
						signalType: "builder_query",
						queryBuilderDraft: {
							id: "q",
							name: "A",
							dataSource: "logs",
							aggregation: "count",
							whereClause: 'service.name = "checkout" AND severity = "error"',
						},
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
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							logsAggregateRows: [{ count: 42 }],
						}),
					),
				),
			)

			assert.strictEqual(result.status, "breached")
			assert.strictEqual(result.value, 42)
			assert.strictEqual(result.sampleCount, 42)
		})
	})

	it.effect("compiles and evaluates a raw SQL query alert", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_raw_sql_test")
				const userId = asUserId("user_raw_sql_test")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Raw SQL alert",
						severity: "critical",
						enabled: true,
						signalType: "raw_query",
						rawQuerySql:
							"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
						rawQueryReducer: "max",
						comparator: "gt",
						threshold: 100,
						windowMinutes: 5,
						minimumSampleCount: 0,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							rawQueryRows: [
								{ value: 120, samples: 8 },
								{ value: 240, samples: 12 },
							],
						}),
					),
				),
			)

			assert.strictEqual(result.status, "breached")
			assert.strictEqual(result.value, 240)
			assert.strictEqual(result.sampleCount, 20)
		})
	})

	it.effect("rejects metrics alerts with multiple attr groupBy dimensions", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
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
			})
				.pipe(
					Effect.provide(
						makeLayer(testDb, makeWarehouseStub({ metricsAggregateRows: emptyWarehouseRows })),
					),
				)
				.pipe(Effect.exit)

			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, AlertValidationError)
			assert.strictEqual(failure.message, "Metrics alerts support at most one attr.* groupBy dimension")
		})
	})

	const VALID_PD_KEY = "e93facc04764012d7bfb002500d5d1a6" // 32 hex chars
	const REST_API_TOKEN = "u+0123456789abcdefgh" // 20 chars, '+' — the common wrong paste

	it.effect("rejects a PagerDuty key of the wrong shape without calling PagerDuty", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: string[] = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			requests.push(String(input))
			return new Response("", { status: 202 })
		}) as typeof fetch

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_pd_shape"),
					asUserId("user_pd_shape"),
					adminRoles,
					{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: REST_API_TOKEN },
				)
			})
				.pipe(
					Effect.provide(
						makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
							fetch: fetchImpl,
						}),
					),
				)
				.pipe(Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, AlertValidationError)
			assert.include(failure.message, "32-character Events API v2 routing key")
			// Format check short-circuits before any network call.
			assert.lengthOf(requests, 0)
		})
	})

	it.effect("rejects a well-formed PagerDuty key that PagerDuty reports invalid", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ url: string; body: string }> = []
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), body: String(init?.body ?? "") })
			return new Response(
				JSON.stringify({
					status: "invalid event",
					message: "Event object is invalid",
					errors: ["Invalid routing key"],
				}),
				{ status: 400 },
			)
		}) as typeof fetch

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_pd_invalid"),
					asUserId("user_pd_invalid"),
					adminRoles,
					{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: VALID_PD_KEY },
				)
			})
				.pipe(
					Effect.provide(
						makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
							fetch: fetchImpl,
						}),
					),
				)
				.pipe(Effect.exit)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, AlertValidationError)
			assert.include(failure.message, "Invalid routing key")
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.url, "https://events.pagerduty.com/v2/enqueue")
			// Validation uses a no-op resolve so it never creates an incident.
			assert.include(requests[0]?.body ?? "", '"event_action":"resolve"')
		})
	})

	it.effect("accepts a PagerDuty key that PagerDuty confirms", () => {
		const testDb = createTestDb(trackedDbs)
		const fetchImpl = (async () => new Response("", { status: 202 })) as typeof fetch
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(
				asOrgId("org_pd_ok"),
				asUserId("user_pd_ok"),
				adminRoles,
				{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: VALID_PD_KEY },
			)
			assert.strictEqual(destination.type, "pagerduty")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("creates the destination when PagerDuty is unreachable (fails open)", () => {
		const testDb = createTestDb(trackedDbs)
		const fetchImpl = (async () => {
			throw new Error("network down")
		}) as typeof fetch
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(
				asOrgId("org_pd_open"),
				asUserId("user_pd_open"),
				adminRoles,
				{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: VALID_PD_KEY },
			)
			assert.strictEqual(destination.type, "pagerduty")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("skips PagerDuty validation on update when the key is left blank", () => {
		const testDb = createTestDb(trackedDbs)
		let calls = 0
		const fetchImpl = (async () => {
			calls += 1
			return new Response("", { status: 202 })
		}) as typeof fetch
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_pd_update")
			const userId = asUserId("user_pd_update")
			const created = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "pagerduty",
				name: "Paging",
				enabled: true,
				integrationKey: VALID_PD_KEY,
			})
			assert.strictEqual(calls, 1) // create validated once

			const updated = yield* alerts.updateDestination(orgId, userId, adminRoles, created.id, {
				type: "pagerduty",
				name: "Paging renamed",
			})
			assert.strictEqual(updated.name, "Paging renamed")
			assert.strictEqual(calls, 1) // no re-validation when the key is omitted
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("opens per-service incidents for grouped logs query alerts", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
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
					signalType: "builder_query",
					queryBuilderDraft: {
						id: "q",
						name: "A",
						dataSource: "logs",
						aggregation: "count",
						whereClause: 'severity = "error"',
						groupBy: ["service.name"],
						addOns: {
							groupBy: true,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
					},
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
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.groupKey, "svc-breach")
			assert.strictEqual(incidents.incidents[0]?.status, "open")
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "svc-breach", count: 14 },
							{ bucket: "2026-01-01 00:00:00", groupName: "svc-healthy", count: 3 },
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	// Regression: the web form persists rule-level groupBy as null for
	// builder_query rules — the grouping lives only in the draft. The scheduler
	// must derive groupedness from the compiled plan, not rule.groupBy, or it
	// evaluates only the first group under "__total__".
	it.effect("fans out per group for builder_query rules grouped only via the draft", () => {
		const testDb = createTestDb(trackedDbs)

		const groupedLogsDraft = (groupBy: string[]) => ({
			id: "q",
			name: "A",
			dataSource: "logs" as const,
			aggregation: "count" as const,
			whereClause: 'severity = "error"',
			groupBy,
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		})

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_draft_grouped")
			const userId = asUserId("user_draft_grouped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Error logs by service (draft grouping)",
					severity: "critical",
					enabled: true,
					signalType: "builder_query",
					queryBuilderDraft: groupedLogsDraft(["service.name"]),
					// Deliberately NO rule-level groupBy — matches what the web form sends.
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

			// Simulate the prod failure mode: a stale "__total__" state row left
			// behind from when this rule evaluated ungrouped.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rule_states (org_id, rule_id, group_key, consecutive_breaches, consecutive_healthy, last_status, updated_at)
					 values ($1, $2, '__total__', 0, 2, 'healthy', now())`,
					[orgId, rule.id],
				),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// The breaching group fires even though the healthy group sorts first.
			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.groupKey, "zzz-breach")
			assert.strictEqual(incidents.incidents[0]?.status, "open")

			// Per-group state rows exist; the stale "__total__" row self-healed away.
			const stateCounts = yield* Effect.promise(() =>
				queryFirstRow<{ total_rows: number; grouped_rows: number }>(
					testDb,
					`select
						count(*) filter (where group_key = '__total__')::int as total_rows,
						count(*) filter (where group_key <> '__total__')::int as grouped_rows
					 from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(stateCounts?.total_rows, 0)
			assert.strictEqual(stateCounts?.grouped_rows, 2)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "aaa-healthy", count: 3 },
							{ bucket: "2026-01-01 00:00:00", groupName: "zzz-breach", count: 14 },
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("deletes stale per-group state rows once a rule evaluates ungrouped", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_ungrouped_heal")
			const userId = asUserId("user_ungrouped_heal")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Leftover from a previous grouped configuration.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rule_states (org_id, rule_id, group_key, consecutive_breaches, consecutive_healthy, last_status, updated_at)
					 values ($1, $2, 'svc-stale', 1, 0, 'breached', now())`,
					[orgId, rule.id],
				),
			)

			yield* alerts.runSchedulerTick()

			const staleCount = yield* Effect.promise(() =>
				queryFirstRow<{ stale: number }>(
					testDb,
					`select count(*)::int as stale from alert_rule_states where rule_id = $1 and group_key <> '__total__'`,
					[rule.id],
				),
			)
			assert.strictEqual(staleCount?.stale, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						tracesAggregateRows: [
							{
								count: 200,
								avgDuration: 20,
								p50Duration: 10,
								p95Duration: 80,
								p99Duration: 160,
								errorRate: 1,
								satisfiedCount: 195,
								toleratingCount: 3,
								apdexScore: 0.9825,
							},
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("treats a draft-only grouping change as structural and resets state", () => {
		const testDb = createTestDb(trackedDbs)

		const draft = (groupBy: string[]) => ({
			id: "q",
			name: "A",
			dataSource: "logs" as const,
			aggregation: "count" as const,
			whereClause: 'severity = "error"',
			groupBy,
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		})
		const request = (overrides: Partial<{ threshold: number; groupBy: string[] }>) =>
			new AlertRuleUpsertRequest({
				name: "Error logs grouping change",
				severity: "critical",
				enabled: true,
				signalType: "builder_query",
				queryBuilderDraft: draft(overrides.groupBy ?? ["service.name"]),
				comparator: "gt",
				threshold: overrides.threshold ?? 10,
				windowMinutes: 5,
				minimumSampleCount: 1,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 30,
				destinationIds: [],
			})

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_draft_group_change")
			const userId = asUserId("user_draft_group_change")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const withDestination = (overrides: Partial<{ threshold: number; groupBy: string[] }>) =>
				new AlertRuleUpsertRequest({ ...request(overrides), destinationIds: [destination.id] })

			const rule = yield* alerts.createRule(orgId, userId, adminRoles, withDestination({}))

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const open = yield* alerts.listIncidents(orgId)
			assert.strictEqual(open.incidents[0]?.status, "open")

			// A non-structural edit (threshold) keeps the incident open.
			yield* alerts.updateRule(orgId, userId, adminRoles, rule.id, withDestination({ threshold: 12 }))
			const afterThreshold = yield* alerts.listIncidents(orgId)
			assert.strictEqual(afterThreshold.incidents[0]?.status, "open")

			// Changing only the draft's grouping is structural: incidents resolve
			// and all state rows reset.
			yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				rule.id,
				withDestination({ threshold: 12, groupBy: ["severity"] }),
			)
			const afterGrouping = yield* alerts.listIncidents(orgId)
			assert.strictEqual(afterGrouping.incidents[0]?.status, "resolved")
			const stateCount = yield* Effect.promise(() =>
				queryFirstRow<{ remaining: number }>(
					testDb,
					`select count(*)::int as remaining from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(stateCount?.remaining, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "zzz-breach", count: 14 },
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("testRule surfaces a breaching non-first group for draft-grouped rules", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_test_draft_grouped")
				const userId = asUserId("user_test_draft_grouped")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Grouped test rule",
						severity: "critical",
						enabled: true,
						signalType: "builder_query",
						queryBuilderDraft: {
							id: "q",
							name: "A",
							dataSource: "logs",
							aggregation: "count",
							whereClause: 'severity = "error"',
							groupBy: ["service.name"],
							addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
						},
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
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							logsAggregateByServiceRows: [
								{ bucket: "2026-01-01 00:00:00", groupName: "aaa-healthy", count: 3 },
								{ bucket: "2026-01-01 00:00:00", groupName: "zzz-breach", count: 14 },
							],
						}),
					),
				),
			)

			assert.strictEqual(result.status, "breached")
			assert.strictEqual(result.value, 14)
		})
	})

	it.effect("blocks destination deletion when rules still reference it", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_delete_guard")
				const userId = asUserId("user_delete_guard")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				yield* createErrorRateRule(alerts, orgId, userId, destination.id)

				return yield* alerts.deleteDestination(orgId, adminRoles, destination.id)
			})
				.pipe(
					Effect.provide(
						makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })),
					),
				)
				.pipe(Effect.exit)

			const failure = getError(exit)
			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, AlertDestinationInUseError)
			assert.isString((failure as { destinationId: unknown }).destinationId)
			assert.deepStrictEqual((failure as { ruleNames: ReadonlyArray<string> }).ruleNames, ["Checkout error rate"])
		})
	})

	it.effect("rejects destination creation for non-admin members", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
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
			})
				.pipe(
					Effect.provide(
						makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })),
					),
				)
				.pipe(Effect.exit)

			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, AlertForbiddenError)
		})
	})

	it.effect("dedupes destinationIds on create and update, preserving selection order", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_dedupe_destinations")
			const userId = asUserId("user_dedupe_destinations")

			const primary = yield* createWebhookDestination(alerts, orgId, userId)
			const secondary = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Secondary webhook",
				enabled: true,
				url: "https://example.com/secondary",
				signingSecret: "webhook-secret-2",
			})

			const baseRule = {
				name: "Duplicate destination rule",
				severity: "warning",
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
			} as const

			// Create with the same id repeated, interleaved with a distinct id — the
			// duplicates collapse but the first-seen order survives.
			const created = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					...baseRule,
					destinationIds: [primary.id, secondary.id, primary.id],
				}),
			)
			assert.deepStrictEqual(created.destinationIds, [primary.id, secondary.id])

			// Updating with duplicates is deduped on the write path too.
			const updated = yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({
					...baseRule,
					destinationIds: [secondary.id, secondary.id],
				}),
			)
			assert.deepStrictEqual(updated.destinationIds, [secondary.id])

			// The persisted row read back is deduped, not just the returned document.
			const rules = yield* alerts.listRules(orgId)
			assert.lengthOf(rules.rules, 1)
			assert.deepStrictEqual(rules.rules[0]?.destinationIds, [secondary.id])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("round-trips and normalizes rule tags through create/update/list", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_rule_tags")
			const userId = asUserId("user_rule_tags")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const baseRule = {
				name: "Tagged rule",
				severity: "warning",
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
				destinationIds: [destination.id],
			} as const

			// Tags are trimmed, lowercased, and deduped (so "Prod" and " prod "
			// collapse to one group key) while preserving first-seen order.
			const created = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({ ...baseRule, tags: ["Prod", " payments ", "prod", ""] }),
			)
			assert.deepStrictEqual(created.tags, ["prod", "payments"])

			// The normalized tags survive a round-trip through the persisted row.
			const afterCreate = yield* alerts.listRules(orgId)
			assert.deepStrictEqual(afterCreate.rules[0]?.tags, ["prod", "payments"])

			// Clearing tags on update persists an empty list, not the prior value.
			const updated = yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({ ...baseRule, tags: [] }),
			)
			assert.deepStrictEqual(updated.tags, [])

			const afterClear = yield* alerts.listRules(orgId)
			assert.deepStrictEqual(afterClear.rules[0]?.tags, [])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("opens per-service incidents for multi-service rules", () => {
		const testDb = createTestDb(trackedDbs)
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

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
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
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 2)
			const groupKeys = incidents.incidents.map((i: { groupKey: string | null }) => i.groupKey).sort()
			assert.deepStrictEqual(groupKeys, ["svc-a", "svc-b"])
			assert.isTrue(incidents.incidents.every((i: { status: string }) => i.status === "open"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("opens per-service incidents for groupBy=service rules", () => {
		const testDb = createTestDb(trackedDbs)

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
			estimatedSpanCount: 200,
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
			estimatedSpanCount: 200,
		}

		const alertRows: ReadonlyArray<Record<string, unknown>> = [breachingRow, healthyRow]
		const stub: WarehouseQueryServiceShape = {
			...makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
			sqlQuery: () => Effect.succeed(alertRows),
			compiledQuery: (_tenant, compiled) => compiled.decodeRows(alertRows).pipe(Effect.orDie),
			compiledQueryFirst: (_tenant, compiled) => compiled.decodeFirstRow(alertRows).pipe(Effect.orDie),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
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
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.groupKey, "svc-breach")
			assert.strictEqual(incidents.incidents[0]?.status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})
})

describe("AlertsService evaluation error persistence", () => {
	const failingWarehouseStub = (state: {
		failing: boolean
		rows: ReadonlyArray<Record<string, unknown>>
		ingested: Array<Record<string, unknown>>
	}): WarehouseQueryServiceShape => {
		const sqlQueryStub = () =>
			state.failing
				? Effect.fail(
						new WarehouseQueryError({
							message: "Unknown column FooBar in traces",
							pipeName: "tracesAlertEval",
						}),
					)
				: Effect.succeed(state.rows)
		return {
			query: () => Effect.die(new Error("Unexpected pipe query")),
			sqlQuery: sqlQueryStub,
			compiledQuery: (_tenant, compiled) =>
				sqlQueryStub().pipe(Effect.flatMap((rows) => compiled.decodeRows(rows).pipe(Effect.orDie))),
			compiledQueryFirst: (_tenant, compiled) =>
				sqlQueryStub().pipe(Effect.flatMap((rows) => compiled.decodeFirstRow(rows).pipe(Effect.orDie))),
			ingest: (_tenant, _datasource, rows) =>
				Effect.sync(() => {
					state.ingested.push(...(rows as Array<Record<string, unknown>>))
				}),
			asExecutor: () => {
				throw new Error("asExecutor is not supported by this test stub")
			},
		}
	}

	it.effect("persists scheduler failures to lastError + audit log, gated, and clears on recovery", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [
				{
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 1,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				},
			],
			ingested: [] as Array<Record<string, unknown>>,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_errors")
			const userId = asUserId("user_alert_errors")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Failing tick: the error must land in alert_rule_states.lastError, be
			// surfaced on listRules, and produce an "error" audit check row.
			yield* alerts.runSchedulerTick()

			const rulesWhileFailing = yield* alerts.listRules(orgId)
			assert.strictEqual(
				rulesWhileFailing.rules[0]?.lastEvaluationError,
				"Unknown column FooBar in traces",
			)
			const errorChecks = state.ingested.filter((row) => row.Status === "error")
			assert.lengthOf(errorChecks, 1)
			assert.strictEqual(errorChecks[0]?.ErrorMessage, "Unknown column FooBar in traces")
			assert.strictEqual(errorChecks[0]?.ErrorCategory, "tinybird_query")
			assert.strictEqual(errorChecks[0]?.GroupKey, "__total__")

			const stateAfterFirstFailure = yield* Effect.promise(() =>
				queryFirstRow<{ updated_at: Date }>(
					testDb,
					"select updated_at from alert_rule_states where rule_id = $1 and group_key = '__total__'",
					[rule.id],
				),
			)
			assert.isDefined(stateAfterFirstFailure)

			// Second failing tick with the SAME message inside the heartbeat window:
			// churn-gated, so the Electric-synced state row must NOT be rewritten.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const stateAfterSecondFailure = yield* Effect.promise(() =>
				queryFirstRow<{ updated_at: Date }>(
					testDb,
					"select updated_at from alert_rule_states where rule_id = $1 and group_key = '__total__'",
					[rule.id],
				),
			)
			assert.strictEqual(
				stateAfterSecondFailure?.updated_at.getTime(),
				stateAfterFirstFailure?.updated_at.getTime(),
			)

			// Recovery: a clean evaluation clears the stored error.
			state.failing = false
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const rulesAfterRecovery = yield* alerts.listRules(orgId)
			assert.isNull(rulesAfterRecovery.rules[0]?.lastEvaluationError)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})
})

describe("AlertsService.previewRule", () => {
	const decodePreviewRequest = Schema.decodeUnknownSync(AlertRulePreviewRequest)

	const bucketRow = (bucket: string, errorRate: number) => ({
		bucket,
		groupName: "all",
		count: 200,
		avgDuration: 40,
		p50Duration: 20,
		p95Duration: 120,
		p99Duration: 240,
		errorRate,
		satisfiedCount: 180,
		toleratingCount: 10,
		apdexScore: 0.925,
	})

	it.effect("returns evaluator-bucketed points and would-fire spans for a spec rule", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				bucketRow("2026-01-01 00:00:00", 10),
				bucketRow("2026-01-01 00:05:00", 12),
				bucketRow("2026-01-01 00:10:00", 1),
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview")

			// No destinations picked yet — preview must not require them.
			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
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
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, request)

			assert.strictEqual(response.bucketSeconds, 300)
			assert.strictEqual(response.windowMinutes, 5)
			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			// 30-minute range at 5-minute windows = 6 evaluation buckets, with the
			// three data-less windows filled in as skipped.
			assert.lengthOf(points, 6)
			assert.strictEqual(points[0]?.status, "breached")
			assert.strictEqual(points[1]?.status, "breached")
			assert.strictEqual(points[2]?.status, "healthy")
			assert.strictEqual(points[3]?.status, "skipped")
			assert.strictEqual(points[0]?.value, 10)
			assert.strictEqual(points[0]?.sampleCount, 200)

			// 2 consecutive breaches required → fires across the first two windows,
			// resolved after 2 consecutive healthy... only 1 healthy then skipped
			// (which freezes counters), so no close within the window either way.
			assert.lengthOf(response.wouldFire, 1)
			assert.strictEqual(response.wouldFire[0]?.start, "2026-01-01T00:00:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("adds a provisional point for the trailing partial window", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				bucketRow("2026-01-01 00:00:00", 10),
				bucketRow("2026-01-01 00:05:00", 12),
				bucketRow("2026-01-01 00:30:00", 8),
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_partial")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
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
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				// 2.5 minutes past the last complete 5-minute boundary.
				endTime: "2026-01-01T00:32:30.000Z",
			})

			const response = yield* alerts.previewRule(orgId, request)

			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			// 6 complete windows plus the in-progress [00:30, 00:32:30) one.
			assert.lengthOf(points, 7)
			assert.isUndefined(points[5]?.provisional)
			const last = points[6]!
			assert.strictEqual(last.bucket, "2026-01-01T00:30:00.000Z")
			assert.strictEqual(last.provisional, true)
			assert.strictEqual(last.status, "breached")
			assert.strictEqual(last.value, 8)

			// The provisional window charts but must not extend the would-fire
			// simulation: the span from the two opening breaches stays the only one,
			// closed at the last complete boundary.
			assert.lengthOf(response.wouldFire, 1)
			assert.strictEqual(response.wouldFire[0]?.start, "2026-01-01T00:00:00.000Z")
			assert.strictEqual(response.wouldFire[0]?.end, "2026-01-01T00:30:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("replays raw-SQL rules per evaluation window", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { rawQueryRows: [{ value: 42, samples: 20 }] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_raw")

			const request = decodePreviewRequest({
				rule: {
					name: "Raw preview",
					severity: "warning",
					enabled: true,
					signalType: "raw_query",
					rawQuerySql: "SELECT count() AS value FROM traces WHERE $__orgFilter",
					rawQueryReducer: "max",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 0,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, request)

			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			assert.lengthOf(points, 6)
			assert.isTrue(points.every((point) => point.value === 42 && point.status === "breached"))
			assert.lengthOf(response.wouldFire, 1)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})
})
