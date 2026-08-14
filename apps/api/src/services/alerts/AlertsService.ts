import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	AlertComparator as AlertComparatorSchema,
	AlertDeliveryError,
	type AlertDeliveryFailure,
	AlertDestinationDecryptionError,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertDestinationStoredConfigInvalidError,
	AlertEvaluationResult,
	AlertEventType as AlertEventTypeSchema,
	AlertForbiddenError,
	AlertIncidentDocument,
	AlertIncidentStatus,
	type AlertDestinationNotFoundError,
	type AlertRuleDestinationNotFoundError,
	type AlertRuleNotFoundError,
	type AlertRuleStoredConfigInvalidError,
	AlertPersistenceError,
	AlertRuleDocument,
	AlertRulePreviewFiringSpan,
	AlertRulePreviewPoint,
	AlertRulePreviewResponse,
	AlertRulePreviewSeries,
	type AlertRulePreviewRequest,
	AlertSeverity as AlertSeveritySchema,
	AlertSignalType as AlertSignalTypeSchema,
	AlertValidationError,
	AlertNotificationTemplate,
	type AlertComparator,
	type AlertDestinationType,
	type AlertEventType as AlertEventTypeValue,
	type AlertRuleUpsertRequest,
	type AlertGroupBy,
	UNGROUPED_GROUP_KEY,
	OrgId,
	type AlertRuleId,
	type AlertDestinationId,
	type AlertIncidentId,
	type WarehouseQueryPathError,
	type QueryEngineTimeoutError,
	type QueryEngineValidationError,
	RoleName,
	UserId as UserIdSchema,
	type UserId,
} from "@maple/domain/http"
import {
	alertDeliveryEvents,
	type AlertDeliveryEventRow,
	alertDestinations,
	type AlertDestinationRow,
	alertIncidents,
	type AlertIncidentRow,
	alertRuleClaims,
	alertRules,
	type AlertRuleRow,
	alertRuleStates,
	type AlertRuleStateRow,
} from "@maple/db"
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Chunk,
	Effect,
	HashSet,
	Layer,
	Match,
	Metric,
	MutableHashMap,
	Option,
	Random,
	Record,
	Result,
	Redacted,
	Ref,
	Schema,
	Context,
} from "effect"
import * as AlertingMetrics from "@/observability/AlertingMetrics"
import { INVESTIGATION_FANOUT_BINDING } from "@/services/errors/ai-triage-enqueue"
import { upsertAlertIssue } from "@/services/errors/issue-hub"
import { probeLiveness } from "@/services/alerts/telemetry-liveness"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import type { TenantContext } from "@/services/auth/AuthService"
import { Database, type DatabaseClient } from "@/platform/DatabaseLive"
import { formatComparator } from "./alert-formatting"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { makeDbExecute } from "@/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import type { GroupedAlertObservation } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import type { AlertChecksRow } from "@maple/domain/tinybird"
import { SlackBotTokenResolver } from "@/services/integrations/slack-bot-token"
import { AlertRuntime } from "./AlertRuntime"
import { AlertDestinationsService, type AlertDestinationsServiceShape } from "./AlertDestinationsService"
import { makeAlertDestinationDelivery, parseAlertDestinationEncryptionKey } from "./AlertDestinationDelivery"
import { AlertReadModelsService, type AlertReadModelsServiceShape } from "./AlertReadModelsService"
import { AlertRulesService, makeAlertRulePersistence, type AlertRulesServiceShape } from "./AlertRulesService"
import {
	compileRulePlan,
	decodeStoredAlertRuleMetadata,
	isGroupedPlan,
	toStorageGroupKey,
	makeAlertValidationError as makeValidationError,
	planEvaluateSource,
	type NormalizedRule,
} from "./AlertRuleModel"
import { resolveSignalDisplay } from "./alert-signal-display"

export { AlertRuntime, type AlertRuntimeShape } from "./AlertRuntime"

interface EvaluatedRule {
	readonly status: Schema.Schema.Type<typeof AlertEvaluationResult.fields.status>
	readonly value: number | null
	readonly sampleCount: number
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly comparator: AlertComparator
	readonly reason: string
	/**
	 * The window returned nothing and `noDataBehavior: "zero"` synthesized the
	 * value. Such a status is a statement about the absence of data, not about
	 * the health of the system — a `gt` rule reads a total ingest outage as
	 * `healthy` this way. Anything that acts on "healthy" destructively (i.e.
	 * resolving an open incident) must prove telemetry is still flowing first.
	 */
	readonly derivedFromNoData: boolean
}

type AlertDestinationStorageError = AlertDestinationDecryptionError | AlertDestinationStoredConfigInvalidError

interface DeliveryAttemptFailure {
	readonly message: string
	readonly kind: string
	readonly retryable: boolean
}

const MAX_DELIVERY_ATTEMPTS = 5
const ALERT_TEST_DELIVERY_CONCURRENCY = 5
const ALERT_CHECK_INGEST_CONCURRENCY = 4
// Storm fuse: cap issue-hub upserts per scheduler tick so a pathological
// group-by rule opening hundreds of incidents can't stall the per-minute tick.
const ISSUE_UPSERTS_PER_TICK = 50
const DELIVERY_LEASE_TTL_MS = 30_000

type DatabaseTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]
type DatabaseExecutor = DatabaseClient | DatabaseTransaction

/* -------------------------------------------------------------------------- */
/*  Schemas for stored JSON formats                                           */
/* -------------------------------------------------------------------------- */

const StoredDeliveryPayloadSchema = Schema.Struct({
	eventType: Schema.optionalKey(Schema.String),
	incidentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	incidentStatus: Schema.optionalKey(Schema.String),
	dedupeKey: Schema.optionalKey(Schema.String),
	rule: Schema.optionalKey(
		Schema.Struct({
			id: Schema.optionalKey(Schema.String),
			name: Schema.optionalKey(Schema.String),
			signalType: Schema.optionalKey(Schema.String),
			severity: Schema.optionalKey(Schema.String),
			groupKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
			comparator: Schema.optionalKey(Schema.String),
			threshold: Schema.optionalKey(Schema.Number),
			thresholdUpper: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			windowMinutes: Schema.optionalKey(Schema.Number),
		}),
	),
	observed: Schema.optionalKey(
		Schema.Struct({
			value: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			sampleCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		}),
	),
	template: Schema.optionalKey(Schema.NullOr(AlertNotificationTemplate)),
})

const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeAlertIncidentStatusSync = Schema.decodeUnknownSync(AlertIncidentStatus)
const decodeAlertEventTypeSync = Schema.decodeUnknownSync(AlertEventTypeSchema)

const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)

const isServiceGroupBy = (groupBy: AlertGroupBy | null): boolean =>
	groupBy != null && groupBy.length === 1 && groupBy[0] === "service.name"

const resolveServiceLinkName = (
	rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
	groupKey: string | null,
): string | null => {
	if (rule.serviceNames.length === 1) return rule.serviceNames[0] ?? null
	if (groupKey != null && groupKey !== UNGROUPED_GROUP_KEY && isServiceGroupBy(rule.groupBy)) {
		return groupKey
	}
	return null
}
// Cap on how many evaluation windows a structured rule preview replays.
const MAX_PREVIEW_BUCKETS = 200

/** Preserve each org's oldest-first order while preventing one org from monopolizing a tick. */
export const interleaveAlertRulesByOrg = <T extends { readonly orgId: string }>(
	rows: ReadonlyArray<T>,
): ReadonlyArray<T> => {
	const queues = new Map<string, T[]>()
	for (const row of rows) {
		const queue = queues.get(row.orgId)
		if (queue) queue.push(row)
		else queues.set(row.orgId, [row])
	}

	const fair: T[] = []
	let index = 0
	while (fair.length < rows.length) {
		for (const queue of queues.values()) {
			const row = queue[index]
			if (row !== undefined) fair.push(row)
		}
		index += 1
	}
	return fair
}

// Tinybird DateTime64(3) wire format for alert_checks ingest:
// "YYYY-MM-DD HH:MM:SS.SSS" (UTC, no timezone).
const toIngestDateTime64 = (epochMs: number) => {
	const d = new Date(epochMs)
	const pad = (n: number, w = 2) => n.toString().padStart(w, "0")
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

const compareThreshold = (
	value: number,
	comparator: AlertComparator,
	threshold: number,
	thresholdUpper: number | null = null,
): boolean =>
	Match.value(comparator).pipe(
		Match.when("gt", () => value > threshold),
		Match.when("gte", () => value >= threshold),
		Match.when("lt", () => value < threshold),
		Match.when("lte", () => value <= threshold),
		Match.when("eq", () => value === threshold),
		Match.when("neq", () => value !== threshold),
		Match.when("between", () => thresholdUpper != null && value >= threshold && value <= thresholdUpper),
		Match.when(
			"not_between",
			() => thresholdUpper != null && (value < threshold || value > thresholdUpper),
		),
		Match.exhaustive,
	)

const makeDeliveryError = (message: string, destinationType?: AlertDestinationType, cause?: unknown) =>
	new AlertDeliveryError({
		message,
		destinationType,
		...(cause === undefined ? {} : { cause }),
	})

type StoredDeliveryPayloadType = Schema.Schema.Type<typeof StoredDeliveryPayloadSchema>

const parseDeliveryPayload = (
	value: unknown,
): Effect.Effect<StoredDeliveryPayloadType, AlertValidationError> =>
	Schema.decodeUnknownEffect(StoredDeliveryPayloadSchema)(value).pipe(
		Effect.mapError((cause) => makeValidationError("Stored delivery payload is invalid", [], cause)),
	)

// Formatting helpers imported from AlertDeliveryDispatch

export interface AlertsServiceShape
	extends AlertDestinationsServiceShape, AlertReadModelsServiceShape, AlertRulesServiceShape {
	readonly updateRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
		request: AlertRuleUpsertRequest,
	) => Effect.Effect<
		AlertRuleDocument,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertRuleNotFoundError
		| AlertRuleDestinationNotFoundError
		| AlertRuleStoredConfigInvalidError
	>
	readonly testRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRuleUpsertRequest,
		sendNotification?: boolean,
	) => Effect.Effect<
		AlertEvaluationResult,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertRuleDestinationNotFoundError
		| AlertDeliveryFailure
		| AlertDestinationStorageError
		| QueryEngineValidationError
		| QueryEngineTimeoutError
		| WarehouseQueryPathError
	>
	/**
	 * `roles` gates raw-SQL previews only: preview itself needs just `alerts:read`,
	 * but replaying a raw_query rule executes user-authored ClickHouse, which is
	 * the org-admin capability `createRule`/`testRule` already require.
	 */
	readonly previewRule: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRulePreviewRequest,
	) => Effect.Effect<
		AlertRulePreviewResponse,
		| AlertValidationError
		| AlertForbiddenError
		| QueryEngineValidationError
		| QueryEngineTimeoutError
		| WarehouseQueryPathError
	>
	readonly runSchedulerTick: () => Effect.Effect<
		{
			readonly evaluatedCount: number
			readonly processedCount: number
			readonly evaluationFailureCount: number
			readonly deliveryFailureCount: number
		},
		| AlertPersistenceError
		| AlertDeliveryFailure
		| AlertValidationError
		| AlertRuleNotFoundError
		| AlertDestinationNotFoundError
		| AlertRuleStoredConfigInvalidError
		// Note: warehouse tagged errors flow up from evaluateRule but are caught
		// inside the per-rule Effect.catch in the scheduler tick, so the tick
		// itself never surfaces them.
	>
}

export class AlertsService extends Context.Service<AlertsService, AlertsServiceShape>()(
	"@maple/api/services/AlertsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const destinations = yield* AlertDestinationsService
			const readModels = yield* AlertReadModelsService
			const rules = yield* AlertRulesService
			const queryEngine = yield* QueryEngineService
			const warehouse = yield* WarehouseQueryService
			const runtime = yield* AlertRuntime
			const email = yield* EmailService
			const orgChSettings = yield* OrgClickHouseSettingsService
			const slackBotToken = yield* SlackBotTokenResolver
			const encryptionKey = yield* parseAlertDestinationEncryptionKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			)
			const destinationDelivery = makeAlertDestinationDelivery({
				encryptionKey,
				appBaseUrl: env.MAPLE_APP_BASE_URL,
				runtime,
				email,
				resolveSlackBotToken: slackBotToken.resolve,
			})
			const {
				hydrateDestination,
				enrichSecretForDispatch,
				composeLinkUrl,
				dispatchDelivery,
				buildPayload,
				sendImmediateNotification,
			} = destinationDelivery
			// Optional: present only inside a Worker isolate. Used to kick off the
			// AI triage Workflow for issues created from freshly opened incidents.
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
			const investigationFanoutBinding = Option.match(workerEnv, {
				onNone: () => undefined,
				onSome: (e) => e[INVESTIGATION_FANOUT_BINDING],
			})
			const now = runtime.now
			const makeUuid = () => runtime.makeUuid()
			const workerId = makeUuid()
			const rulePersistence = makeAlertRulePersistence({ database, runtime })
			const {
				normalizeRule,
				normalizeRuleRow,
				requireAdmin,
				requireDestinationIds,
				requireRuleRow,
				upsertRuleRow,
			} = rulePersistence

			const dbExecute = makeDbExecute(database, "AlertsService", makePersistenceError)

			const systemTenant = (orgId: OrgId): TenantContext => ({
				orgId,
				userId: decodeUserIdSync("system-alerting"),
				roles: [decodeRoleNameSync("root")],
				authMode: "self_hosted",
			})

			/**
			 * Services a rule's telemetry-liveness probe should cover. An empty list
			 * means the rule is org-wide, and the probe falls back to the org pulse.
			 */
			const livenessServicesFor = (rule: NormalizedRule): ReadonlyArray<string> =>
				rule.serviceNames.length > 0
					? rule.serviceNames
					: rule.serviceName != null
						? [rule.serviceName]
						: []

			/**
			 * Would resolving this incident be believing an absence rather than an
			 * observation? Compares the window that looks recovered against the
			 * equivalent window before the incident opened.
			 */
			const telemetryStillFlowing = Effect.fn("AlertsService.telemetryStillFlowing")(function* (
				orgId: OrgId,
				normalized: NormalizedRule,
				incidentOpenedAtMs: number,
				timestamp: number,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const windowMs = Math.max(normalized.windowMinutes, 1) * 60_000
				return yield* probeLiveness({
					warehouse,
					tenant: systemTenant(orgId),
					serviceNames: livenessServicesFor(normalized),
					windowStartMs: timestamp - windowMs,
					windowEndMs: timestamp,
					baselineStartMs: incidentOpenedAtMs - windowMs,
					baselineEndMs: incidentOpenedAtMs,
				})
			})

			/**
			 * Evaluate the alert rule and return one outcome per group.
			 *
			 * This is the single boundary between the query engine's group-key
			 * vocabulary and storage's. The engine emits a generic `"all"` for an
			 * ungrouped result; every returned `groupKey` here is already in storage
			 * vocabulary — `UNGROUPED_GROUP_KEY` for an ungrouped plan, a real group
			 * name otherwise — so no caller re-derives it. For grouped rules every
			 * distinct value (or composite value, when multiple dimensions are
			 * picked) becomes its own entry, processed and dedup'd independently
			 * downstream.
			 */
			const evaluateRule = Effect.fn("AlertsService.evaluateRule")(function* (
				orgId: OrgId,
				rule: NormalizedRule,
			): Effect.fn.Return<
				ReadonlyArray<{ evaluation: EvaluatedRule; groupKey: string }>,
				| AlertValidationError
				| QueryEngineValidationError
				| QueryEngineTimeoutError
				| WarehouseQueryPathError
			> {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": rule.id })
				const endMs = yield* now
				const startMs = endMs - rule.windowMinutes * 60_000
				const plan = rule.compiledPlan
				const source = yield* planEvaluateSource(plan, rule.windowMinutes)
				const observations: ReadonlyArray<GroupedAlertObservation> = yield* queryEngine.evaluate(
					systemTenant(orgId),
					{
						startTime: formatWarehouseDateTime(startMs),
						endTime: formatWarehouseDateTime(endMs),
						source,
						reducer: plan.reducer,
						sampleCountStrategy: plan.sampleCountStrategy,
					},
				)

				return observations.map((obs) => ({
					evaluation: applyEvaluationLogic(rule, obs),
					groupKey: toStorageGroupKey(plan, obs.groupKey),
				}))
			})

			const applyEvaluationLogic = (
				rule: NormalizedRule,
				obs: Pick<GroupedAlertObservation, "value" | "sampleCount" | "hasData">,
				reasonOverride?: string,
			): EvaluatedRule => {
				const noDataBehavior = rule.compiledPlan.noDataBehavior
				// Sample-weighted counts arrive fractional from the warehouse
				// (`sum(SampleRate)`), and this flows into `last_sample_count`, an
				// `integer` column — an unrounded value fails the insert outright.
				const sampleCount = Math.round(obs.sampleCount)
				const value = obs.hasData ? obs.value : noDataBehavior === "zero" ? 0 : null

				if (!obs.hasData && noDataBehavior === "skip") {
					return {
						status: "skipped",
						value: null,
						sampleCount,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						comparator: rule.comparator,
						reason: "No data in the selected window",
						// Inert: `skipped` never resolves an incident, so this branch
						// short-circuits before any status is derived from a synthesized value.
						derivedFromNoData: false,
					}
				}

				if (sampleCount < rule.minimumSampleCount) {
					return {
						status: "skipped",
						value,
						sampleCount,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						comparator: rule.comparator,
						reason: `Sample count ${sampleCount} is below minimum ${rule.minimumSampleCount}`,
						derivedFromNoData: false,
					}
				}

				if (value == null) {
					return {
						status: "skipped",
						value: null,
						sampleCount,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						comparator: rule.comparator,
						reason: "Alert evaluation did not return a scalar value",
						derivedFromNoData: false,
					}
				}

				return {
					status: compareThreshold(value, rule.comparator, rule.threshold, rule.thresholdUpper)
						? "breached"
						: "healthy",
					value,
					sampleCount,
					threshold: rule.threshold,
					thresholdUpper: rule.thresholdUpper,
					comparator: rule.comparator,
					reason:
						reasonOverride ??
						`${rule.signalType} ${formatComparator(rule.comparator, rule.threshold, rule.thresholdUpper)}`,
					// Only reachable with `noDataBehavior: "zero"` — the "skip" branch
					// returned above. The comparison ran against a fabricated 0.
					derivedFromNoData: !obs.hasData,
				}
			}

			const buildDeliveryKey = (
				incidentId: string,
				destinationId: string,
				eventType: AlertEventTypeValue,
				scheduledAt: number,
			) => [incidentId, destinationId, eventType, scheduledAt].join(":")

			const insertDeliveryEventRecord = (
				db: DatabaseExecutor,
				orgId: OrgId,
				incidentId: AlertIncidentId | null,
				ruleId: AlertRuleId,
				destinationId: AlertDestinationId,
				eventType: AlertEventTypeValue,
				payload: Record<string, unknown>,
				scheduledAt: number,
				deliveryKey: string,
				attemptNumber: number,
			) =>
				db
					.insert(alertDeliveryEvents)
					.values({
						id: decodeAlertDeliveryEventIdSync(makeUuid()),
						orgId,
						incidentId,
						ruleId,
						destinationId,
						deliveryKey,
						eventType,
						attemptNumber,
						status: "queued",
						scheduledAt: new Date(scheduledAt),
						claimedAt: null,
						claimExpiresAt: null,
						claimedBy: null,
						attemptedAt: null,
						providerMessage: null,
						providerReference: null,
						responseCode: null,
						errorMessage: null,
						payloadJson: payload,
						createdAt: new Date(scheduledAt),
						updatedAt: new Date(scheduledAt),
					})
					.onConflictDoNothing()

			const insertDeliveryEvent = Effect.fn("AlertsService.insertDeliveryEvent")(function* (
				orgId: OrgId,
				incidentId: AlertIncidentId | null,
				ruleId: AlertRuleId,
				destinationId: AlertDestinationId,
				eventType: AlertEventTypeValue,
				payload: Record<string, unknown>,
				scheduledAt: number,
				deliveryKey: string,
				attemptNumber: number,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.alert.rule_id": ruleId,
					"maple.alert.destination_id": destinationId,
				})
				yield* dbExecute((db) =>
					insertDeliveryEventRecord(
						db,
						orgId,
						incidentId,
						ruleId,
						destinationId,
						eventType,
						payload,
						scheduledAt,
						deliveryKey,
						attemptNumber,
					),
				)
			})

			const resolveNotificationLinkUrl = (
				rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
				groupKey: string | null,
			) => composeLinkUrl(resolveServiceLinkName(rule, groupKey))

			const toDeliveryAttemptFailure = (
				error:
					| AlertValidationError
					| AlertDeliveryFailure
					| AlertPersistenceError
					| AlertDestinationStorageError
					| AlertRuleStoredConfigInvalidError,
			): DeliveryAttemptFailure => ({
				message: error.message,
				kind: error.error.code,
				retryable: error.error.retryable,
			})

			const queueIncidentNotifications = Effect.fn("AlertsService.queueIncidentNotifications")(
				function* (
					orgId: OrgId,
					rule: NormalizedRule,
					incident: AlertIncidentRow,
					evaluation: EvaluatedRule,
					eventType: AlertEventTypeValue,
					scheduledAt: number,
				) {
					if (rule.destinationIds.length === 0) return

					const rows = yield* dbExecute((db) =>
						db
							.select({
								id: alertDestinations.id,
								enabled: alertDestinations.enabled,
							})
							.from(alertDestinations)
							.where(
								and(
									eq(alertDestinations.orgId, orgId),
									inArray(alertDestinations.id, [...rule.destinationIds]),
								),
							),
					)

					const destinations = new Map(rows.map((row) => [row.id, row]))
					const payload = buildPayload({
						eventType,
						incidentId: incident.id,
						incidentStatus: decodeAlertIncidentStatusSync(incident.status),
						dedupeKey: incident.dedupeKey,
						ruleId: rule.id,
						ruleName: rule.name,
						groupKey: incident.groupKey,
						signalType: rule.signalType,
						severity: rule.severity,
						comparator: rule.comparator,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						windowMinutes: rule.windowMinutes,
						value: evaluation.value,
						sampleCount: evaluation.sampleCount,
						template: rule.notificationTemplate,
						linkUrl: resolveNotificationLinkUrl(rule, incident.groupKey),
						sentAtMs: scheduledAt,
					})

					yield* Effect.forEach(
						rule.destinationIds,
						(destinationId) => {
							const destination = destinations.get(destinationId)
							if (!destination || !destination.enabled) return Effect.void
							return dbExecute((db) =>
								insertDeliveryEventRecord(
									db,
									orgId,
									incident.id,
									rule.id,
									destinationId,
									eventType,
									payload,
									scheduledAt,
									buildDeliveryKey(incident.id, destinationId, eventType, scheduledAt),
									1,
								),
							)
						},
						{ discard: true },
					)
				},
			)

			// Exponential backoff up to 15 min, plus 0–999 ms jitter sourced from
			// Effect's `Random` service so tests can fix the seed deterministically.
			const computeRetryDelayMs = Effect.fn("AlertsService.computeRetryDelayMs")(function* (
				attemptNumber: number,
			) {
				const base = Math.min(60_000 * Math.pow(2, attemptNumber - 1), 15 * 60_000)
				const jitter = yield* Random.nextIntBetween(0, 1_000)
				return base + jitter
			})

			const updateRule = Effect.fn("AlertsService.updateRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				ruleId: AlertRuleDocument["id"],
				request: AlertRuleUpsertRequest,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"tenant.userId": userId,
					"maple.alert.rule_id": ruleId,
				})
				yield* requireAdmin(roles)
				const oldRow = yield* requireRuleRow(orgId, ruleId)
				const oldNormalized = yield* normalizeRuleRow(oldRow)
				const newNormalized = yield* normalizeRule(orgId, request)
				const result = yield* upsertRuleRow(orgId, userId, ruleId, request)

				// Resolve stale incidents caused by the configuration change

				if (oldNormalized.enabled && !newNormalized.enabled) {
					// Rule was disabled — resolve all open incidents
					yield* resolveStaleIncidents(orgId, ruleId, newNormalized, {
						resolveAll: true,
					})
				} else if (ruleStructureChanged(oldNormalized, newNormalized)) {
					// Evaluation mode changed — resolve all and let scheduler re-evaluate fresh
					yield* resolveStaleIncidents(orgId, ruleId, newNormalized, {
						resolveAll: true,
					})
				} else {
					const staleGroupKeys = computeStaleGroupKeys(oldNormalized, newNormalized)
					if (HashSet.size(staleGroupKeys) > 0) {
						yield* resolveStaleIncidents(orgId, ruleId, newNormalized, {
							staleGroupKeys,
						})
					}
				}

				return result
			})

			const testRule = Effect.fn("AlertsService.testRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: AlertRuleUpsertRequest,
				sendNotification = false,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
				yield* requireAdmin(roles)
				const normalized = yield* normalizeRule(orgId, request)
				yield* requireDestinationIds(orgId, normalized.destinationIds)

				let evaluation: EvaluatedRule
				if (normalized.serviceNames.length > 1) {
					const results = yield* Effect.forEach(
						normalized.serviceNames,
						(svcName) =>
							Effect.gen(function* () {
								const perServicePlan = yield* compileRulePlan({
									...normalized,
									serviceName: svcName,
								})
								const observations = yield* evaluateRule(orgId, {
									...normalized,
									serviceName: svcName,
									compiledPlan: perServicePlan,
								})
								return (
									observations[0]?.evaluation ?? {
										status: "skipped" as const,
										value: null,
										sampleCount: 0,
										threshold: normalized.threshold,
										thresholdUpper: normalized.thresholdUpper,
										comparator: normalized.comparator,
										reason: "No data",
									}
								)
							}),
						{ concurrency: 5 },
					)
					evaluation = results.find((r) => r.status === "breached") ??
						results[0] ?? {
							status: "skipped" as const,
							value: null,
							sampleCount: 0,
							threshold: normalized.threshold,
							thresholdUpper: normalized.thresholdUpper,
							comparator: normalized.comparator,
							reason: "No data",
						}
				} else {
					// Uniform grouped/ungrouped path — mirrors runSchedulerTick: the
					// compiled plan decides groupedness, and a breaching group (if any)
					// wins so the test reflects what the scheduler would fire on.
					const allResults = yield* evaluateRule(orgId, normalized)
					const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
					const results = isGroupedPlan(normalized.compiledPlan)
						? Arr.filter(allResults, (r) => !HashSet.has(excludeSet, r.groupKey))
						: allResults
					const breached = results.find((r) => r.evaluation.status === "breached")
					evaluation = breached?.evaluation ??
						results[0]?.evaluation ?? {
							status: "skipped" as const,
							value: null,
							sampleCount: 0,
							threshold: normalized.threshold,
							thresholdUpper: normalized.thresholdUpper,
							comparator: normalized.comparator,
							reason: "No data",
						}
				}

				if (sendNotification) {
					const rows = yield* dbExecute((db) =>
						db
							.select()
							.from(alertDestinations)
							.where(
								and(
									eq(alertDestinations.orgId, orgId),
									inArray(alertDestinations.id, [...normalized.destinationIds]),
								),
							),
					)
					const byId = new Map(rows.map((row) => [row.id, row]))
					const enabledDestinations = normalized.destinationIds
						.map((id) => ({ id, row: byId.get(id) }))
						.filter(
							(d): d is { id: AlertDestinationId; row: AlertDestinationRow } =>
								d.row != null && d.row.enabled,
						)

					const sentAtMs = yield* now
					yield* Effect.forEach(
						enabledDestinations,
						({ id: destinationId, row: destination }) =>
							sendImmediateNotification(destination, {
								deliveryKey: `${orgId}:${destinationId}:rule-test`,
								ruleId: decodeAlertRuleIdSync(makeUuid()),
								ruleName: normalized.name,
								groupKey: null,
								signalType: normalized.signalType,
								signalDisplay: resolveSignalDisplay(normalized),
								severity: normalized.severity,
								comparator: normalized.comparator,
								threshold: normalized.threshold,
								thresholdUpper: normalized.thresholdUpper,
								windowMinutes: normalized.windowMinutes,
								eventType: "test",
								incidentId: null,
								incidentStatus: "resolved",
								dedupeKey: `${orgId}:${destinationId}:rule-test`,
								value: evaluation.value,
								sampleCount: evaluation.sampleCount,
								template: normalized.notificationTemplate,
								linkUrl: resolveNotificationLinkUrl(normalized, null),
								sentAtMs,
							}),
						{ concurrency: ALERT_TEST_DELIVERY_CONCURRENCY },
					)
				}

				return new AlertEvaluationResult(evaluation)
			})

			/**
			 * Evaluator-faithful preview of a rule over a time range. Runs the exact
			 * compiled plan the scheduler runs, at the evaluator's tumbling
			 * `windowMinutes` buckets, and simulates the consecutive-breach state
			 * machine to report when the rule would have fired. One bucket == one
			 * evaluation window, so what this returns is what the tracking chart
			 * shows once the rule is live.
			 *
			 * Fidelity caveat: the live scheduler slides its window every tick
			 * (~1 min) while the preview uses tumbling windows, so `wouldFire` spans
			 * are approximate between bucket boundaries.
			 */
			const previewRule = Effect.fn("AlertsService.previewRule")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
				request: AlertRulePreviewRequest,
			): Effect.fn.Return<
				AlertRulePreviewResponse,
				| AlertValidationError
				| AlertForbiddenError
				| QueryEngineValidationError
				| QueryEngineTimeoutError
				| WarehouseQueryPathError
			> {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const normalized = yield* normalizeRule(orgId, request.rule, {
					forPreview: true,
				})
				const plan = normalized.compiledPlan

				// Preview only needs `alerts:read`, but a raw-SQL rule executes
				// user-authored ClickHouse against the org's warehouse — the same
				// capability `createRule`/`testRule` gate behind org-admin. Previewing
				// one must not be a cheaper route to that than creating it.
				if (plan.kind === "raw_sql") {
					yield* requireAdmin(roles)
				}

				const windowMs = normalized.windowMinutes * 60_000
				const requestedStartMs = Date.parse(request.startTime)
				const requestedEndMs = Date.parse(request.endTime)
				if (
					!Number.isFinite(requestedStartMs) ||
					!Number.isFinite(requestedEndMs) ||
					requestedEndMs <= requestedStartMs
				) {
					return yield* Effect.fail(makeValidationError("Invalid preview time range"))
				}

				// Tumbling windows aligned to the epoch — the same alignment the CH
				// timeseries bucketing (toStartOfInterval) uses, so the preview grid
				// lines up with the rows evaluateSeries returns.
				const endMs = Math.floor(requestedEndMs / windowMs) * windowMs
				const alignedStartMs = Math.floor(requestedStartMs / windowMs) * windowMs
				const maxBuckets = MAX_PREVIEW_BUCKETS
				const minStartMs = endMs - maxBuckets * windowMs
				const startMs = Math.max(alignedStartMs, minStartMs)
				if (endMs - startMs < windowMs) {
					return yield* Effect.fail(
						makeValidationError("Preview range must span at least one evaluation window"),
					)
				}
				const truncatedToStart =
					alignedStartMs < minStartMs
						? decodeIsoDateTimeStringSync(new Date(startMs).toISOString())
						: null

				const bucketStarts: number[] = []
				for (let t = startMs; t + windowMs <= endMs; t += windowMs) {
					bucketStarts.push(t)
				}

				// The trailing in-progress window [endMs, requestedEndMs) — evaluated as a
				// provisional bucket keyed at endMs so the chart reaches "now" instead of
				// dropping up to a full window of the freshest data. Its rows land in the
				// epoch-aligned bucket starting at endMs, so the series query just extends.
				const hasPartialBucket = requestedEndMs - endMs >= 60_000
				const queryEndMs = hasPartialBucket ? requestedEndMs : endMs
				const pointBuckets = hasPartialBucket ? Arr.append(bucketStarts, endMs) : bucketStarts

				yield* Effect.annotateCurrentSpan({
					orgId,
					"alert.plan_kind": plan.kind,
					"alert.window_minutes": normalized.windowMinutes,
					"alert.preview.buckets": pointBuckets.length,
					"alert.preview.has_partial_bucket": hasPartialBucket,
				})

				// Raw per-(group, bucket) observations; buckets missing here are
				// no-data windows and get filled from the grid below.
				interface PreviewObs {
					readonly value: number | null
					readonly sampleCount: number
					readonly hasData: boolean
				}
				const obsByGroup = new Map<string, Map<number, PreviewObs>>()
				const record = (groupKey: string, bucketMs: number, obs: PreviewObs) => {
					let buckets = obsByGroup.get(groupKey)
					if (!buckets) {
						buckets = new Map()
						obsByGroup.set(groupKey, buckets)
					}
					buckets.set(bucketMs, obs)
				}

				if (normalized.serviceNames.length > 1) {
					// Mirror the scheduler's multi-service mode: independent per-service
					// plans, groupKey = service name.
					yield* Effect.forEach(
						normalized.serviceNames,
						(svcName) =>
							Effect.gen(function* () {
								const perServicePlan = yield* compileRulePlan({
									...normalized,
									serviceName: svcName,
								})
								const perServiceSource = yield* planEvaluateSource(
									perServicePlan,
									normalized.windowMinutes,
								)
								const observations = yield* queryEngine.evaluateSeries(systemTenant(orgId), {
									startTime: formatWarehouseDateTime(startMs),
									endTime: formatWarehouseDateTime(queryEndMs),
									source: perServiceSource,
									reducer: perServicePlan.reducer,
									sampleCountStrategy: perServicePlan.sampleCountStrategy,
								})
								for (const obs of observations) {
									record(svcName, Date.parse(obs.bucket), {
										value: obs.value,
										sampleCount: obs.sampleCount,
										hasData: obs.sampleCount > 0,
									})
								}
							}),
						{ concurrency: 5 },
					)
				} else {
					const source = yield* planEvaluateSource(plan, normalized.windowMinutes)
					const observations = yield* queryEngine.evaluateSeries(systemTenant(orgId), {
						startTime: formatWarehouseDateTime(startMs),
						endTime: formatWarehouseDateTime(queryEndMs),
						source,
						reducer: plan.reducer,
						sampleCountStrategy: plan.sampleCountStrategy,
					})
					const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
					// Preview must key its series exactly as the scheduler stores them,
					// or the preview chart and the tracking chart disagree on the
					// ungrouped series' name.
					for (const obs of observations) {
						if (HashSet.has(excludeSet, obs.groupKey)) continue
						record(toStorageGroupKey(plan, obs.groupKey), Date.parse(obs.bucket), {
							value: obs.value,
							sampleCount: obs.sampleCount,
							hasData: obs.sampleCount > 0,
						})
					}
				}

				// Ungrouped rules always observe *something* per tick, so chart a series
				// even when the whole range is empty.
				if (
					obsByGroup.size === 0 &&
					!isGroupedPlan(normalized.compiledPlan) &&
					normalized.serviceNames.length <= 1
				) {
					obsByGroup.set(UNGROUPED_GROUP_KEY, new Map())
				}

				const NO_DATA: PreviewObs = {
					value: null,
					sampleCount: 0,
					hasData: false,
				}
				const iso = (ms: number) => decodeIsoDateTimeStringSync(new Date(ms).toISOString())

				const series: AlertRulePreviewSeries[] = []
				const wouldFire: AlertRulePreviewFiringSpan[] = []
				for (const [groupKey, buckets] of obsByGroup) {
					const points: AlertRulePreviewPoint[] = []
					// Simulate the scheduler's saturating counters (skipped freezes both —
					// same as processEvaluation).
					let breaches = 0
					let healthy = 0
					let openStart: number | null = null
					for (const bucketMs of pointBuckets) {
						const obs = buckets.get(bucketMs) ?? NO_DATA
						const evaluation = applyEvaluationLogic(normalized, obs)
						const provisional = hasPartialBucket && bucketMs === endMs
						points.push(
							new AlertRulePreviewPoint({
								bucket: iso(bucketMs),
								value: evaluation.value,
								sampleCount: obs.sampleCount,
								status: evaluation.status,
								...(provisional ? { provisional } : {}),
							}),
						)
						// The in-progress window charts but doesn't feed the incident
						// simulation — the scheduler hasn't evaluated it yet.
						if (provisional) continue
						if (evaluation.status === "breached") {
							breaches = Math.min(breaches + 1, normalized.consecutiveBreachesRequired)
							healthy = 0
						} else if (evaluation.status === "healthy") {
							healthy = Math.min(healthy + 1, normalized.consecutiveHealthyRequired)
							breaches = 0
						}
						if (openStart == null && breaches >= normalized.consecutiveBreachesRequired) {
							// Shade from the start of the run's first breached window.
							openStart = bucketMs - (normalized.consecutiveBreachesRequired - 1) * windowMs
						} else if (openStart != null && healthy >= normalized.consecutiveHealthyRequired) {
							wouldFire.push(
								new AlertRulePreviewFiringSpan({
									groupKey,
									start: iso(openStart),
									end: iso(bucketMs + windowMs),
								}),
							)
							openStart = null
						}
					}
					if (openStart != null) {
						wouldFire.push(
							new AlertRulePreviewFiringSpan({
								groupKey,
								start: iso(openStart),
								end: iso(endMs),
							}),
						)
					}
					series.push(new AlertRulePreviewSeries({ groupKey, points }))
				}

				yield* Effect.annotateCurrentSpan({
					"result.seriesCount": series.length,
					"result.wouldFireCount": wouldFire.length,
				})

				return new AlertRulePreviewResponse({
					bucketSeconds: windowMs / 1000,
					windowMinutes: normalized.windowMinutes,
					threshold: normalized.threshold,
					thresholdUpper: normalized.thresholdUpper,
					comparator: normalized.comparator,
					truncatedToStart,
					series,
					wouldFire,
				})
			})

			const claimableDeliveryWhere = (currentTime: number) =>
				or(
					and(
						eq(alertDeliveryEvents.status, "queued"),
						lte(alertDeliveryEvents.scheduledAt, new Date(currentTime)),
					),
					and(
						eq(alertDeliveryEvents.status, "processing"),
						isNotNull(alertDeliveryEvents.claimExpiresAt),
						lte(alertDeliveryEvents.claimExpiresAt, new Date(currentTime)),
					),
				)

			const claimDeliveryEvent = (deliveryEventId: AlertDeliveryEventRow["id"], currentTime: number) =>
				dbExecute((db) =>
					db
						.update(alertDeliveryEvents)
						.set({
							status: "processing",
							claimedAt: new Date(currentTime),
							claimExpiresAt: new Date(currentTime + DELIVERY_LEASE_TTL_MS),
							claimedBy: workerId,
							updatedAt: new Date(currentTime),
						})
						.where(
							and(
								eq(alertDeliveryEvents.id, deliveryEventId),
								claimableDeliveryWhere(currentTime),
							),
						)
						.returning({ id: alertDeliveryEvents.id }),
				)

			const finalizeClaimedDelivery = (
				deliveryEventId: AlertDeliveryEventRow["id"],
				currentTime: number,
				fields: Partial<AlertDeliveryEventRow> & {
					readonly status: "success" | "failed"
				},
			) =>
				dbExecute((db) =>
					db
						.update(alertDeliveryEvents)
						.set({
							...fields,
							claimedAt: null,
							claimExpiresAt: null,
							claimedBy: null,
							updatedAt: new Date(currentTime),
						})
						.where(
							and(
								eq(alertDeliveryEvents.id, deliveryEventId),
								eq(alertDeliveryEvents.status, "processing"),
								eq(alertDeliveryEvents.claimedBy, workerId),
							),
						),
				)

			const recordDeliveryFailure = Effect.fn("AlertsService.recordDeliveryFailure")(function* (
				row: AlertDeliveryEventRow,
				currentTime: number,
				failure: DeliveryAttemptFailure,
			) {
				yield* finalizeClaimedDelivery(row.id, currentTime, {
					status: "failed",
					attemptedAt: new Date(currentTime),
					errorMessage: failure.message,
				})
				yield* Effect.logWarning("Alert delivery attempt failed").pipe(
					Effect.annotateLogs({
						workerId,
						deliveryKey: row.deliveryKey,
						attemptNumber: row.attemptNumber,
						destinationId: row.destinationId,
						failureKind: failure.kind,
						errorMessage: failure.message,
					}),
				)
			})

			const processQueuedDeliveries = Effect.fn("AlertsService.processQueuedDeliveries")(function* () {
				const currentTime = yield* now
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertDeliveryEvents)
						.where(claimableDeliveryWhere(currentTime))
						.orderBy(asc(alertDeliveryEvents.scheduledAt)),
				)

				if (rows.length === 0) {
					return {
						processedCount: 0,
						failureCount: 0,
					}
				}

				const uniqueDestinationIds = Arr.dedupe(Arr.map(rows, (r) => r.destinationId))
				const uniqueRuleIds = Arr.dedupe(Arr.map(rows, (r) => r.ruleId))
				const uniqueIncidentIds = Arr.dedupe(
					Arr.filterMap(rows, (r) =>
						r.incidentId != null ? Result.succeed(r.incidentId) : Result.failVoid,
					),
				)

				const [allDestinations, allRules, allIncidents] = yield* Effect.all(
					[
						dbExecute((db) =>
							db
								.select()
								.from(alertDestinations)
								.where(inArray(alertDestinations.id, uniqueDestinationIds)),
						),
						dbExecute((db) =>
							db.select().from(alertRules).where(inArray(alertRules.id, uniqueRuleIds)),
						),
						uniqueIncidentIds.length > 0
							? dbExecute((db) =>
									db
										.select()
										.from(alertIncidents)
										.where(inArray(alertIncidents.id, uniqueIncidentIds)),
								)
							: Effect.succeed([] as AlertIncidentRow[]),
					],
					{ concurrency: "unbounded" },
				)

				const destinationMap = new Map(allDestinations.map((r) => [r.id, r]))
				const ruleMap = new Map(allRules.map((r) => [r.id, r]))
				const incidentMap = new Map(allIncidents.map((r) => [r.id, r]))

				let processedCount = 0
				let failureCount = 0

				const processOneDelivery = Effect.fn("AlertsService.processOneDelivery")(function* (
					row: AlertDeliveryEventRow,
				) {
					const claimed = yield* claimDeliveryEvent(row.id, currentTime)
					if (claimed.length === 0) return

					processedCount += 1
					yield* Metric.update(AlertingMetrics.deliveriesAttemptedTotal, 1)

					const destinationRow = destinationMap.get(row.destinationId)
					if (!destinationRow) {
						failureCount += 1
						yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
						yield* recordDeliveryFailure(row, currentTime, {
							message: "Destination not found",
							kind: "destination",
							retryable: false,
						})
						return
					}

					if (!destinationRow.enabled) {
						failureCount += 1
						yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
						yield* recordDeliveryFailure(row, currentTime, {
							message: "Destination disabled",
							kind: "destination",
							retryable: false,
						})
						return
					}

					const payload = yield* parseDeliveryPayload(row.payloadJson)
					const hydrated = yield* hydrateDestination(destinationRow)
					const incidentRow: AlertIncidentRow | null =
						row.incidentId != null ? (incidentMap.get(row.incidentId) ?? null) : null
					const ruleRow = ruleMap.get(row.ruleId) ?? null
					const payloadRule = payload.rule
					const storedRule = ruleRow ? yield* decodeStoredAlertRuleMetadata(ruleRow) : null
					const groupKey = incidentRow?.groupKey ?? payloadRule?.groupKey ?? null
					const signalType = decodeAlertSignalTypeSync(
						incidentRow?.signalType ?? payloadRule?.signalType ?? "throughput",
					)

					const enrichedSecret = yield* enrichSecretForDispatch(hydrated.row, hydrated.secretConfig)
					const deliveryStart = yield* now
					const result = yield* dispatchDelivery(
						{
							deliveryKey: row.deliveryKey,
							destination: hydrated.row,
							publicConfig: hydrated.publicConfig,
							secretConfig: enrichedSecret,
							ruleId: decodeAlertRuleIdSync(row.ruleId),
							ruleName: ruleRow?.name ?? String(payloadRule?.name ?? "Alert"),
							groupKey,
							signalType,
							// The rule row is the only place the measured quantity is
							// named — the delivery payload carries just the query kind.
							signalDisplay: resolveSignalDisplay({
								signalType,
								queryBuilderDraft: storedRule?.queryBuilderDraft ?? null,
								rawQueryReducer: ruleRow?.reducer ?? null,
							}),
							severity: decodeAlertSeveritySync(
								incidentRow?.severity ?? payloadRule?.severity ?? "warning",
							),
							comparator: decodeAlertComparatorSync(
								incidentRow?.comparator ?? payloadRule?.comparator ?? "gt",
							),
							threshold: incidentRow?.threshold ?? payloadRule?.threshold ?? 0,
							thresholdUpper:
								incidentRow?.thresholdUpper ?? payloadRule?.thresholdUpper ?? null,
							windowMinutes: ruleRow?.windowMinutes ?? payloadRule?.windowMinutes ?? 5,
							eventType: decodeAlertEventTypeSync(row.eventType),
							incidentId: row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
							incidentStatus: decodeAlertIncidentStatusSync(incidentRow?.status ?? "resolved"),
							dedupeKey: incidentRow?.dedupeKey ?? String(payload.dedupeKey ?? row.deliveryKey),
							value: payload.observed?.value ?? null,
							sampleCount: payload.observed?.sampleCount ?? null,
							template: payload.template ?? storedRule?.notificationTemplate ?? null,
							linkUrl: resolveNotificationLinkUrl(
								{
									serviceNames: storedRule?.serviceNames ?? [],
									groupBy: storedRule?.groupBy ?? null,
								},
								groupKey,
							),
							sentAtMs: deliveryStart,
						},
						JSON.stringify(row.payloadJson),
					)
					yield* Metric.update(
						AlertingMetrics.deliveryAttemptDurationMs,
						(yield* now) - deliveryStart,
					)
					yield* Metric.update(AlertingMetrics.deliveriesSucceededTotal, 1)

					yield* finalizeClaimedDelivery(row.id, currentTime, {
						status: "success",
						attemptedAt: new Date(currentTime),
						providerMessage: result.providerMessage,
						providerReference: result.providerReference,
						responseCode: result.responseCode,
						errorMessage: null,
					})

					if (row.incidentId) {
						yield* dbExecute((db) =>
							db
								.update(alertIncidents)
								.set({
									lastDeliveredEventType: row.eventType,
									lastNotifiedAt: new Date(currentTime),
									updatedAt: new Date(currentTime),
								})
								.where(eq(alertIncidents.id, row.incidentId!)),
						)
					}

					yield* Effect.logInfo("Alert delivery attempt succeeded").pipe(
						Effect.annotateLogs({
							workerId,
							deliveryKey: row.deliveryKey,
							attemptNumber: row.attemptNumber,
							destinationId: row.destinationId,
							responseCode: result.responseCode,
						}),
					)
				})

				const recoverDeliveryFailure = Effect.fnUntraced(function* (
					row: AlertDeliveryEventRow,
					error:
						| AlertValidationError
						| AlertDeliveryFailure
						| AlertPersistenceError
						| AlertDestinationStorageError
						| AlertRuleStoredConfigInvalidError,
				) {
					const failure = toDeliveryAttemptFailure(error)
					failureCount += 1
					yield* Metric.update(AlertingMetrics.deliveriesFailedTotal, 1)
					yield* finalizeClaimedDelivery(row.id, currentTime, {
						status: "failed",
						attemptedAt: new Date(currentTime),
						errorMessage: failure.message,
					})

					if (failure.retryable && row.attemptNumber < MAX_DELIVERY_ATTEMPTS) {
						// Carry the original delivery payload through the retry. Empty
						// payloads here would force the next attempt to fall back on
						// rule-row defaults, losing observed value, sample count,
						// dedupe context, and links.
						const retryPayload = (yield* parseDeliveryPayload(row.payloadJson).pipe(
							Effect.orElseSucceed(() => ({})),
						)) as Record<string, unknown>
						yield* insertDeliveryEvent(
							row.orgId,
							row.incidentId,
							row.ruleId,
							row.destinationId,
							decodeAlertEventTypeSync(row.eventType),
							retryPayload,
							currentTime + (yield* computeRetryDelayMs(row.attemptNumber)),
							row.deliveryKey,
							row.attemptNumber + 1,
						)
					}

					yield* Effect.logWarning("Alert delivery attempt failed").pipe(
						Effect.annotateLogs({
							workerId,
							deliveryKey: row.deliveryKey,
							attemptNumber: row.attemptNumber,
							destinationId: row.destinationId,
							failureKind: failure.kind,
							errorMessage: failure.message,
							willRetry: failure.retryable && row.attemptNumber < MAX_DELIVERY_ATTEMPTS,
						}),
					)
				})

				yield* Effect.forEach(rows, (row) =>
					processOneDelivery(row).pipe(Effect.catch((error) => recoverDeliveryFailure(row, error))),
				)

				return {
					processedCount,
					failureCount,
				}
			})

			const processEvaluation = Effect.fn("AlertsService.processEvaluation")(function* (
				row: AlertRuleRow,
				normalized: NormalizedRule,
				evaluation: EvaluatedRule,
				groupKey: string,
				timestamp: number,
				pendingChecks: Ref.Ref<Chunk.Chunk<AlertChecksRow>>,
				issueBudget: Ref.Ref<number>,
				prefetch: TickPrefetch,
			) {
				const stateConflictTarget: [
					typeof alertRuleStates.orgId,
					typeof alertRuleStates.ruleId,
					typeof alertRuleStates.groupKey,
				] = [alertRuleStates.orgId, alertRuleStates.ruleId, alertRuleStates.groupKey]

				// Serialized per rule via the claim lock at runSchedulerTick (SCHEDULER_LOCK_TTL_MS
				// CAS on alertRules.lastScheduledAt). The statements below are separate
				// sequential writes (no transaction) and stay idempotent on retry: state
				// upsert via onConflictDoUpdate, incident insert keyed on unique
				// incidentKey, delivery events via onConflictDoNothing on deliveryKey.
				const evaluateTransition = Effect.fnUntraced(function* () {
					// Both reads come from the tick-head prefetch rather than a query per
					// group. Safe because this function is the only writer of either key
					// and runs at most once per key per tick — see `loadTickPrefetch`.
					const state = prefetch.stateFor(row.orgId, row.id, groupKey)

					// The open incident for this group, via the unique
					// (orgId, ruleId, status, groupKey) combination. Composite group
					// keys make serviceName ambiguous, so groupKey is authoritative.
					const openIncident = prefetch.openIncidentFor(row.orgId, row.id, groupKey)

					// Default for check-history ingest: carry open-incident linkage (if any),
					// transition remains "none" unless a branch below overrides it.
					const carriedIncidentId = openIncident?.id ?? null

					// `alert_rule_states` is Electric-synced: every write advances the shape
					// log and wakes every connected client's live long-poll. Unchanged-state
					// ticks therefore skip the upsert entirely, refreshing lastEvaluatedAt at
					// most every STATE_HEARTBEAT_MS. The equality gate deliberately ignores
					// lastValue/lastSampleCount — they float every tick for real metrics and
					// nothing downstream reads their freshness (the web client and listRules
					// consume only lastError + lastEvaluatedAt from this table); they catch up
					// on every transition/heartbeat write.
					const upsertState = (fields: {
						consecutiveBreaches: number
						consecutiveHealthy: number
						lastStatus: string
						lastValue: number | null
						lastSampleCount: number
					}) => {
						const unchanged =
							state != null &&
							state.consecutiveBreaches === fields.consecutiveBreaches &&
							state.consecutiveHealthy === fields.consecutiveHealthy &&
							state.lastStatus === fields.lastStatus &&
							state.lastError == null &&
							state.lastEvaluatedAt != null &&
							timestamp - state.lastEvaluatedAt.getTime() < STATE_HEARTBEAT_MS
						if (unchanged) return Effect.void
						return dbExecute((db) =>
							db
								.insert(alertRuleStates)
								.values({
									orgId: row.orgId,
									ruleId: row.id,
									groupKey,
									...fields,
									lastEvaluatedAt: new Date(timestamp),
									lastError: null,
									updatedAt: new Date(timestamp),
								})
								.onConflictDoUpdate({
									target: stateConflictTarget,
									set: {
										...fields,
										lastEvaluatedAt: new Date(timestamp),
										lastError: null,
										updatedAt: new Date(timestamp),
									},
								}),
						)
					}

					if (evaluation.status === "skipped") {
						const consecutiveBreaches = state?.consecutiveBreaches ?? 0
						const consecutiveHealthy = state?.consecutiveHealthy ?? 0
						yield* upsertState({
							consecutiveBreaches,
							consecutiveHealthy,
							lastStatus: evaluation.status,
							lastValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
						})
						return {
							transition: "none" as const,
							incidentId: carriedIncidentId,
							openedIncidentId: null,
							consecutiveBreaches,
							consecutiveHealthy,
						}
					}

					// Capped at the rule's thresholds: the counters are only ever compared
					// with >= against *Required, so saturating keeps open/resolve behavior
					// identical while letting steady-state ticks skip the state upsert above.
					const consecutiveBreaches =
						evaluation.status === "breached"
							? Math.min(
									(state?.consecutiveBreaches ?? 0) + 1,
									normalized.consecutiveBreachesRequired,
								)
							: 0
					const consecutiveHealthy =
						evaluation.status === "healthy"
							? Math.min(
									(state?.consecutiveHealthy ?? 0) + 1,
									normalized.consecutiveHealthyRequired,
								)
							: 0

					yield* upsertState({
						consecutiveBreaches,
						consecutiveHealthy,
						lastStatus: evaluation.status,
						lastValue: evaluation.value,
						lastSampleCount: evaluation.sampleCount,
					})

					if (
						evaluation.status === "breached" &&
						openIncident == null &&
						consecutiveBreaches >= normalized.consecutiveBreachesRequired
					) {
						// Flap suppression: a metric oscillating around the threshold opens
						// a fresh incident per flap, which would email an identical trigger
						// notification every few minutes. If the previous incident for this
						// (rule, group) was notified within the renotify interval, open the
						// incident but skip the trigger notification and carry the prior
						// lastNotifiedAt forward — the renotify gate then enforces one
						// email per interval while the flapping persists.
						const priorNotified =
							(yield* dbExecute((db) =>
								db
									.select({ lastNotifiedAt: alertIncidents.lastNotifiedAt })
									.from(alertIncidents)
									.where(
										and(
											eq(alertIncidents.orgId, row.orgId),
											eq(alertIncidents.ruleId, row.id),
											eq(alertIncidents.groupKey, groupKey),
											eq(alertIncidents.status, "resolved"),
											isNotNull(alertIncidents.lastNotifiedAt),
											gte(
												alertIncidents.lastNotifiedAt,
												new Date(
													timestamp - normalized.renotifyIntervalMinutes * 60_000,
												),
											),
										),
									)
									.orderBy(desc(alertIncidents.lastNotifiedAt))
									.limit(1),
							))[0] ?? null
						const flapSuppressedAt = priorNotified?.lastNotifiedAt ?? null

						const incidentId = decodeAlertIncidentIdSync(makeUuid())
						const incident: AlertIncidentRow = {
							id: incidentId,
							orgId: row.orgId,
							ruleId: row.id,
							incidentKey: incidentId,
							ruleName: row.name,
							groupKey,
							signalType: normalized.signalType,
							severity: normalized.severity,
							status: "open",
							comparator: normalized.comparator,
							threshold: normalized.threshold,
							thresholdUpper: normalized.thresholdUpper,
							firstTriggeredAt: new Date(timestamp),
							lastTriggeredAt: new Date(timestamp),
							resolvedAt: null,
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: new Date(timestamp),
							dedupeKey: `${row.orgId}:${row.id}:${groupKey}`,
							lastDeliveredEventType: null,
							// Suppressed flaps inherit the prior incident's notify anchor so
							// the renotify gate spaces the next email a full interval from
							// the last one the user actually received.
							lastNotifiedAt: flapSuppressedAt,
							errorIssueId: null,
							createdAt: new Date(timestamp),
							updatedAt: new Date(timestamp),
						}

						yield* dbExecute((db) => db.insert(alertIncidents).values(incident))
						if (flapSuppressedAt != null) {
							yield* Effect.logInfo("Skipping trigger notification for flapping incident").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									incidentId,
									groupKey,
									priorNotifiedAt: flapSuppressedAt.toISOString(),
								}),
							)
						} else {
							yield* queueIncidentNotifications(
								row.orgId,
								normalized,
								incident,
								evaluation,
								"trigger",
								timestamp,
							)
						}
						return {
							transition: "opened" as const,
							incidentId,
							openedIncidentId: incidentId,
							consecutiveBreaches,
							consecutiveHealthy,
						}
					}

					if (evaluation.status === "breached" && openIncident != null) {
						const refreshedIncident = {
							...openIncident,
							lastTriggeredAt: new Date(timestamp),
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: new Date(timestamp),
							updatedAt: new Date(timestamp),
						}

						const renotifyDueAt =
							(openIncident.lastNotifiedAt ?? openIncident.firstTriggeredAt).getTime() +
							normalized.renotifyIntervalMinutes * 60_000
						const renotifyDue = renotifyDueAt <= timestamp

						// The gate closes at QUEUE time, not delivery time: advancing
						// lastNotifiedAt only on delivery success re-queues a fresh event
						// (new scheduledAt → new deliveryKey) every tick while a delivery
						// is failing or slow, and the whole backlog fires once the
						// destination recovers. Failed deliveries are covered by the
						// per-event retry chain instead. Written before queueing so a
						// crash in between skips one interval rather than duplicating.
						yield* dbExecute((db) =>
							db
								.update(alertIncidents)
								.set({
									lastTriggeredAt: new Date(timestamp),
									lastObservedValue: evaluation.value,
									lastSampleCount: evaluation.sampleCount,
									lastEvaluatedAt: new Date(timestamp),
									updatedAt: new Date(timestamp),
									...(renotifyDue ? { lastNotifiedAt: new Date(timestamp) } : {}),
								})
								.where(eq(alertIncidents.id, openIncident.id)),
						)

						if (renotifyDue) {
							yield* queueIncidentNotifications(
								row.orgId,
								normalized,
								refreshedIncident,
								evaluation,
								"renotify",
								timestamp,
							)
						}
						return {
							transition: "continued" as const,
							incidentId: openIncident.id,
							openedIncidentId: null,
							consecutiveBreaches,
							consecutiveHealthy,
						}
					}

					if (
						evaluation.status === "healthy" &&
						openIncident != null &&
						consecutiveHealthy >= normalized.consecutiveHealthyRequired
					) {
						// A "healthy" synthesized from an empty window is a statement
						// about missing data, not about a recovered system: with
						// `noDataBehavior: "zero"` a total ingest outage compares as 0 <
						// threshold and would resolve every incident it touches, paging
						// out a wave of false all-clears. Believe it only once telemetry
						// is provably still arriving.
						if (evaluation.derivedFromNoData) {
							const liveness = yield* telemetryStillFlowing(
								row.orgId,
								normalized,
								openIncident.firstTriggeredAt.getTime(),
								timestamp,
							)
							if (!liveness.dataFlowing) {
								yield* Effect.logWarning(
									"Holding incident open: healthy evaluation came from missing telemetry",
								).pipe(
									Effect.annotateLogs({
										orgId: row.orgId,
										ruleId: row.id,
										incidentId: openIncident.id,
										groupKey,
										livenessReason: liveness.reason,
										observedCount: liveness.observedCount,
										baselineCount: liveness.baselineCount,
									}),
								)
								return {
									transition: "none" as const,
									incidentId: carriedIncidentId,
									openedIncidentId: null,
									consecutiveBreaches,
									consecutiveHealthy,
								}
							}
						}

						const resolvedIncident = {
							...openIncident,
							status: "resolved" as const,
							resolvedAt: new Date(timestamp),
							lastObservedValue: evaluation.value,
							lastSampleCount: evaluation.sampleCount,
							lastEvaluatedAt: new Date(timestamp),
							updatedAt: new Date(timestamp),
						}

						yield* dbExecute((db) =>
							db
								.update(alertIncidents)
								.set({
									status: "resolved",
									resolvedAt: new Date(timestamp),
									lastObservedValue: evaluation.value,
									lastSampleCount: evaluation.sampleCount,
									lastEvaluatedAt: new Date(timestamp),
									updatedAt: new Date(timestamp),
								})
								.where(eq(alertIncidents.id, openIncident.id)),
						)

						// A flap-suppressed incident (notify anchor inherited, nothing ever
						// delivered for it) resolves silently too — pairing every silent
						// open with a resolve email would spam just as hard as the
						// triggers we suppressed.
						const resolveSuppressed =
							openIncident.lastDeliveredEventType == null && openIncident.lastNotifiedAt != null
						if (resolveSuppressed) {
							yield* Effect.logInfo("Skipping resolve notification for flapping incident").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									incidentId: openIncident.id,
									groupKey,
								}),
							)
						} else {
							yield* queueIncidentNotifications(
								row.orgId,
								normalized,
								resolvedIncident,
								evaluation,
								"resolve",
								timestamp,
							)
						}
						return {
							transition: "resolved" as const,
							incidentId: openIncident.id,
							openedIncidentId: null,
							consecutiveBreaches,
							consecutiveHealthy,
						}
					}

					return {
						transition: "none" as const,
						incidentId: carriedIncidentId,
						openedIncidentId: null,
						consecutiveBreaches,
						consecutiveHealthy,
					}
				})
				const outcome = yield* evaluateTransition()

				if (outcome.transition === "opened") {
					yield* Metric.update(AlertingMetrics.incidentsOpenedTotal, 1)
				}
				if (outcome.transition === "resolved") {
					yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, 1)
				}

				// Issue-hub: a freshly opened incident creates/refreshes its issue
				// (kind="alert") so it lands in the unified triage queue. Budgeted per
				// tick as a storm fuse for pathological group-by rules; upsertAlertIssue
				// never fails, so the scheduler tick is isolated from issue problems.
				if (outcome.openedIncidentId != null) {
					const incidentId = outcome.openedIncidentId
					const allowed = yield* Ref.modify(issueBudget, (remaining): [boolean, number] =>
						remaining > 0 ? [true, remaining - 1] : [false, remaining],
					)
					if (allowed) {
						yield* upsertAlertIssue({
							orgId: row.orgId,
							ruleId: row.id,
							ruleName: row.name,
							groupKey,
							signalType: normalized.signalType,
							severity: normalized.severity,
							comparator: normalized.comparator,
							threshold: normalized.threshold,
							thresholdUpper: normalized.thresholdUpper,
							windowMinutes: normalized.windowMinutes,
							observedValue: evaluation.value,
							sampleCount: evaluation.sampleCount,
							incidentId,
							serviceName:
								normalized.groupBy?.[0] === "service.name"
									? groupKey
									: (normalized.serviceNames[0] ?? ""),
							timestamp,
							fanoutBinding: investigationFanoutBinding,
						}).pipe(Effect.provideService(Database, database))
					} else {
						yield* Effect.logWarning(
							"Alert issue upsert budget exhausted; skipping issue link",
						).pipe(Effect.annotateLogs({ ruleId: row.id, incidentId, groupKey }))
					}
				}

				// Record one audit row per evaluation to the Tinybird alert_checks datasource.
				const evaluationEndMs = yield* now
				const checkRow: AlertChecksRow = {
					OrgId: row.orgId,
					RuleId: row.id,
					GroupKey: groupKey,
					Timestamp: toIngestDateTime64(timestamp),
					Status: evaluation.status,
					SignalType: normalized.signalType,
					Comparator: normalized.comparator,
					Threshold: normalized.threshold,
					ObservedValue: evaluation.value,
					SampleCount: evaluation.sampleCount,
					WindowMinutes: normalized.windowMinutes,
					WindowStart: toIngestDateTime64(timestamp - normalized.windowMinutes * 60_000),
					WindowEnd: toIngestDateTime64(timestamp),
					ConsecutiveBreaches: outcome.consecutiveBreaches,
					ConsecutiveHealthy: outcome.consecutiveHealthy,
					IncidentId: outcome.incidentId,
					IncidentTransition: outcome.transition,
					EvaluationDurationMs: Math.max(0, evaluationEndMs - timestamp),
					ErrorMessage: null,
					ErrorCategory: "",
				}
				// Buffer instead of POSTing per-evaluation; the scheduler tick flushes
				// all rows once at the end (one POST per orgId). Awaited flush keeps
				// the Cloudflare Worker isolate alive across the batch write.
				yield* Ref.update(pendingChecks, Chunk.append(checkRow))
			})

			/* -------------------------------------------------------------------------- */
			/*  Stale incident resolution                                               */
			/* -------------------------------------------------------------------------- */

			const computeStaleGroupKeys = (
				oldRule: NormalizedRule,
				newRule: NormalizedRule,
			): HashSet.HashSet<string> => {
				const removedServices = HashSet.difference(
					HashSet.fromIterable(oldRule.serviceNames),
					HashSet.fromIterable(newRule.serviceNames),
				)
				const newlyExcluded = HashSet.difference(
					HashSet.fromIterable(newRule.excludeServiceNames),
					HashSet.fromIterable(oldRule.excludeServiceNames),
				)
				return HashSet.union(removedServices, newlyExcluded)
			}

			const groupByEqual = (
				a: ReadonlyArray<string> | null,
				b: ReadonlyArray<string> | null,
			): boolean => {
				if (a == null || b == null) return a == null && b == null
				if (a.length !== b.length) return false
				for (let i = 0; i < a.length; i++) {
					if (a[i] !== b[i]) return false
				}
				return true
			}

			/**
			 * The user-facing grouping keys a rule evaluates by — rule-level groupBy,
			 * or the builder draft's groupBy for builder_query rules (which always
			 * persist rule-level groupBy as null). Compared at key level because
			 * different attribute keys (attr.http.route vs attr.http.method) compile
			 * to the same spec token ("attribute").
			 */
			const effectiveGroupByKeys = (rule: NormalizedRule): ReadonlyArray<string> | null => {
				if (rule.groupBy != null && rule.groupBy.length > 0) return rule.groupBy
				const draft = rule.queryBuilderDraft
				if (
					rule.signalType === "builder_query" &&
					draft?.addOns?.groupBy === true &&
					draft.groupBy != null &&
					draft.groupBy.length > 0
				) {
					return draft.groupBy
				}
				return null
			}

			const ruleStructureChanged = (oldRule: NormalizedRule, newRule: NormalizedRule): boolean => {
				if (!groupByEqual(effectiveGroupByKeys(oldRule), effectiveGroupByKeys(newRule))) return true
				if (oldRule.signalType !== newRule.signalType) return true
				const mode = (r: NormalizedRule) =>
					isGroupedPlan(r.compiledPlan) ? "grouped" : r.serviceNames.length > 1 ? "multi" : "single"
				return mode(oldRule) !== mode(newRule)
			}

			const makeSyntheticResolveEvaluation = (
				normalized: NormalizedRule,
				reason: string,
			): EvaluatedRule => ({
				status: "healthy",
				value: null,
				sampleCount: 0,
				threshold: normalized.threshold,
				thresholdUpper: normalized.thresholdUpper,
				comparator: normalized.comparator,
				reason,
				// This "healthy" is fabricated for config-driven resolves (rule changed,
				// group vanished), not derived from an empty query window. Callers that
				// resolve on absence gate themselves — see resolveOrphanedGroupIncidents.
				derivedFromNoData: false,
			})

			const resolveStaleIncidents = Effect.fn("AlertsService.resolveStaleIncidents")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				normalized: NormalizedRule,
				opts: {
					readonly staleGroupKeys?: HashSet.HashSet<string>
					readonly resolveAll?: boolean
				},
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
				const openIncidents = yield* dbExecute((db) =>
					db
						.select()
						.from(alertIncidents)
						.where(
							and(
								eq(alertIncidents.orgId, orgId),
								eq(alertIncidents.ruleId, ruleId),
								eq(alertIncidents.status, "open"),
							),
						),
				)

				const toResolve = opts.resolveAll
					? openIncidents
					: Arr.filter(
							openIncidents,
							(i) =>
								i.groupKey != null &&
								(opts.staleGroupKeys ? HashSet.has(opts.staleGroupKeys, i.groupKey) : false),
						)

				if (toResolve.length === 0) return

				const timestamp = yield* now
				const syntheticEvaluation = makeSyntheticResolveEvaluation(
					normalized,
					"Auto-resolved: rule configuration changed",
				)
				const staleGroupKeys = Arr.map(toResolve, (i) => i.groupKey ?? UNGROUPED_GROUP_KEY)

				// Serialized per rule via the claim lock + idempotent writes
				// (incident status update converges; delivery events onConflictDoNothing).
				yield* Effect.forEach(toResolve, (incident) =>
					Effect.gen(function* () {
						const resolvedIncident = {
							...incident,
							status: "resolved" as const,
							resolvedAt: new Date(timestamp),
							updatedAt: new Date(timestamp),
						}

						yield* dbExecute((db) =>
							db
								.update(alertIncidents)
								.set({
									status: "resolved",
									resolvedAt: new Date(timestamp),
									updatedAt: new Date(timestamp),
								})
								.where(eq(alertIncidents.id, incident.id)),
						)

						yield* queueIncidentNotifications(
							orgId,
							normalized,
							resolvedIncident,
							syntheticEvaluation,
							"resolve",
							timestamp,
						)
					}),
				)

				if (opts.resolveAll) {
					yield* dbExecute((db) =>
						db
							.delete(alertRuleStates)
							.where(and(eq(alertRuleStates.orgId, orgId), eq(alertRuleStates.ruleId, ruleId))),
					)
				} else if (staleGroupKeys.length > 0) {
					yield* dbExecute((db) =>
						db
							.delete(alertRuleStates)
							.where(
								and(
									eq(alertRuleStates.orgId, orgId),
									eq(alertRuleStates.ruleId, ruleId),
									inArray(alertRuleStates.groupKey, staleGroupKeys),
								),
							),
					)
				}

				yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, toResolve.length)
				yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, toResolve.length)
			})

			const resolveOrphanedGroupIncidents = Effect.fn("AlertsService.resolveOrphanedGroupIncidents")(
				function* (
					orgId: OrgId,
					ruleId: AlertRuleId,
					normalized: NormalizedRule,
					evaluatedGroups: HashSet.HashSet<string>,
					timestamp: number,
					openIncidents: ReadonlyArray<AlertIncidentRow>,
				) {
					// Supplied from the tick-head prefetch instead of re-read here — this
					// was the single heaviest query shape in the service, because it read
					// the same set `processEvaluation` had already read moments earlier.
					//
					// Only incidents whose group was NOT evaluated survive the filter
					// below, and an unevaluated group is by definition one this tick wrote
					// nothing for, so the snapshot and a fresh read agree on every row that
					// matters here. What the snapshot cannot see is an incident resolved
					// out-of-band (a manual resolve via the API) since the tick began. The
					// resolve statement below is guarded on `status = 'open'` and gated on
					// its own row count so that case is a no-op rather than a duplicate
					// all-clear notification.
					const orphaned = Arr.filter(
						openIncidents,
						(i) => !HashSet.has(evaluatedGroups, i.groupKey ?? UNGROUPED_GROUP_KEY),
					)

					if (orphaned.length === 0) return

					// A group leaves the result set either because the thing it described
					// genuinely went away, or because the service stopped reporting — and
					// this path closes the incident AND fires a resolve notification, so
					// getting it wrong pages an all-clear in the middle of an ingest
					// outage. Anchor the baseline at the oldest orphan: whatever traffic
					// existed when these incidents opened should still be there.
					const oldestOpenedAtMs = orphaned.reduce(
						(oldest, incident) => Math.min(oldest, incident.firstTriggeredAt.getTime()),
						Number.POSITIVE_INFINITY,
					)
					const liveness = yield* telemetryStillFlowing(
						orgId,
						normalized,
						oldestOpenedAtMs,
						timestamp,
					)
					if (!liveness.dataFlowing) {
						yield* Effect.logWarning(
							"Holding orphaned-group incidents open: telemetry gap, not a vanished group",
						).pipe(
							Effect.annotateLogs({
								orgId,
								ruleId,
								orphanedCount: orphaned.length,
								livenessReason: liveness.reason,
								observedCount: liveness.observedCount,
								baselineCount: liveness.baselineCount,
							}),
						)
						return
					}

					const syntheticEvaluation = makeSyntheticResolveEvaluation(
						normalized,
						"Auto-resolved: group no longer appears in evaluation results",
					)

					// Serialized per rule via claim lock + idempotent writes.
					const resolveOutcomes = yield* Effect.forEach(orphaned, (incident) => {
						const groupKey = incident.groupKey ?? UNGROUPED_GROUP_KEY
						return Effect.gen(function* () {
							// `status = 'open'` in the predicate, plus RETURNING, is what makes
							// the prefetched snapshot safe: if this incident was resolved
							// out-of-band since the tick began, zero rows come back and we skip
							// the notification instead of paging a second all-clear. (The old
							// re-read had the same race between its own select and update; this
							// closes it rather than just narrowing it.)
							const resolved = yield* dbExecute((db) =>
								db
									.update(alertIncidents)
									.set({
										status: "resolved",
										resolvedAt: new Date(timestamp),
										updatedAt: new Date(timestamp),
									})
									.where(
										and(
											eq(alertIncidents.id, incident.id),
											eq(alertIncidents.status, "open"),
										),
									)
									.returning({ id: alertIncidents.id }),
							)
							if (resolved.length === 0) return false

							yield* queueIncidentNotifications(
								orgId,
								normalized,
								{
									...incident,
									status: "resolved",
									resolvedAt: new Date(timestamp),
									updatedAt: new Date(timestamp),
								},
								syntheticEvaluation,
								"resolve",
								timestamp,
							)

							yield* dbExecute((db) =>
								db
									.delete(alertRuleStates)
									.where(
										and(
											eq(alertRuleStates.orgId, orgId),
											eq(alertRuleStates.ruleId, ruleId),
											eq(alertRuleStates.groupKey, groupKey),
										),
									),
							)
							return true
						})
					})

					// Counts what actually resolved, not what was a candidate: an incident
					// resolved out-of-band since the tick began is skipped above and must
					// not be counted here.
					const resolvedCount = Arr.countBy(resolveOutcomes, (ok) => ok)
					yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, resolvedCount)
					yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, resolvedCount)
				},
			)

			const SCHEDULER_LOCK_TTL_MS = 30_000

			// Unchanged-state ticks skip the alert_rule_states upsert so the Electric
			// shape stays quiet; lastEvaluatedAt is refreshed at most this often.
			const STATE_HEARTBEAT_MS = 5 * 60_000

			// `alert_rules.last_scheduled_at` is still exposed on the API and read by the
			// web diagnosis panel, but it is only refreshed this often — the per-minute
			// claim itself lives in the unpublished `alert_rule_claims` table so it never
			// enters Electric's replication stream. Mirrors STATE_HEARTBEAT_MS above.
			const SCHEDULER_HEARTBEAT_MS = 5 * 60_000

			/**
			 * CAS the per-rule scheduler lock, then refresh the user-visible heartbeat.
			 *
			 * Both statements run inside ONE `execute`: under `DatabasePgLive` each call
			 * dials and tears down its own postgres.js client, so the handshake count is
			 * what costs, not the statement count — same trade as
			 * `ErrorsService.loadOrgTickPreamble`. These are the two statements every
			 * rule paid for on every tick.
			 *
			 * The claim: the `INSERT` arm covers the first tick for a rule; `setWhere`
			 * makes a loser's conflict update a no-op so `RETURNING` stays empty.
			 * Winning returns one row, losing returns zero, so callers keep using
			 * `claimed.length === 0` to bail.
			 *
			 * The heartbeat: `alert_rules.last_scheduled_at` is gated in SQL so it
			 * touches zero rows — and writes no WAL tuple — on the ~4 of every 5 ticks
			 * that fall inside the heartbeat window. It runs only for the claim winner,
			 * and its failure is swallowed so it cannot cost a rule its evaluation:
			 * the claim is already committed by then, and the heartbeat is cosmetic.
			 */
			const claimAndTouchRule = (orgId: OrgId, ruleId: AlertRuleId, timestamp: number) =>
				dbExecute(async (db) => {
					const claimed = await db
						.insert(alertRuleClaims)
						.values({ ruleId, orgId, lastScheduledAt: new Date(timestamp) })
						.onConflictDoUpdate({
							target: alertRuleClaims.ruleId,
							set: { lastScheduledAt: new Date(timestamp) },
							setWhere: lt(
								alertRuleClaims.lastScheduledAt,
								new Date(timestamp - SCHEDULER_LOCK_TTL_MS),
							),
						})
						.returning({ id: alertRuleClaims.ruleId })

					if (claimed.length === 0) return claimed

					try {
						await db
							.update(alertRules)
							.set({ lastScheduledAt: new Date(timestamp) })
							.where(
								and(
									eq(alertRules.id, ruleId),
									or(
										isNull(alertRules.lastScheduledAt),
										lt(
											alertRules.lastScheduledAt,
											new Date(timestamp - SCHEDULER_HEARTBEAT_MS),
										),
									),
								),
							)
					} catch {
						// Matches the `Effect.ignore` this call carried when it was a
						// separate execute.
					}

					return claimed
				})

			/**
			 * The two per-rule reads the scheduler used to issue inside its loop,
			 * fetched once for the whole tick.
			 *
			 * Between them these were ~13k queries/hour in production — one
			 * `alert_rule_states` select and one `alert_incidents` select per rule per
			 * group per minute, each paying a full dial under `DatabasePgLive`.
			 *
			 * Hoisting them is not a staleness trade, because of how the writes are
			 * scoped. Every key here is `(orgId, ruleId, groupKey)`, `processEvaluation`
			 * runs at most once per key per tick, and its writes only ever touch its own
			 * key: the state upsert targets that key's primary key, and both incident
			 * updates target `openIncident.id` — the incident belonging to that same
			 * key. So no group can read a value another group has invalidated.
			 *
			 * `openIncidentsForRule` is the exception and is documented at its use site
			 * in `resolveOrphanedGroupIncidents`.
			 */
			interface TickPrefetch {
				readonly stateFor: (
					orgId: OrgId,
					ruleId: AlertRuleId,
					groupKey: string,
				) => AlertRuleStateRow | null
				readonly openIncidentFor: (
					orgId: OrgId,
					ruleId: AlertRuleId,
					groupKey: string,
				) => AlertIncidentRow | null
				readonly openIncidentsForRule: (
					orgId: OrgId,
					ruleId: AlertRuleId,
				) => ReadonlyArray<AlertIncidentRow>
			}

			const EMPTY_INCIDENTS: ReadonlyArray<AlertIncidentRow> = []

			const groupCacheKey = (orgId: string, ruleId: string, groupKey: string) =>
				`${orgId}\u0000${ruleId}\u0000${groupKey}`
			const ruleCacheKey = (orgId: string, ruleId: string) => `${orgId}\u0000${ruleId}`

			/**
			 * Load the tick's state and open-incident rows in ONE `execute`.
			 *
			 * Two statements, one dial — the handshake is the cost, not the statement
			 * (`ErrorsService.loadOrgTickPreamble`). `orgId` is in both predicates for
			 * the index rather than for correctness: rule ids are globally unique, so
			 * the id list already scopes the read, but without `orgId` neither predicate
			 * can use its leading index column.
			 */
			const loadTickPrefetch = Effect.fnUntraced(function* (rows: ReadonlyArray<AlertRuleRow>) {
				if (Arr.isReadonlyArrayEmpty(rows)) {
					return {
						stateFor: () => null,
						openIncidentFor: () => null,
						openIncidentsForRule: () => EMPTY_INCIDENTS,
					} satisfies TickPrefetch
				}

				const ruleIds = Arr.map(rows, (row) => row.id)
				const orgIds = Arr.dedupe(Arr.map(rows, (row) => row.orgId))

				const { stateRows, incidentRows } = yield* dbExecute(async (db) => {
					const [stateRows, incidentRows] = await Promise.all([
						db
							.select()
							.from(alertRuleStates)
							.where(
								and(
									inArray(alertRuleStates.orgId, orgIds),
									inArray(alertRuleStates.ruleId, ruleIds),
								),
							),
						db
							.select()
							.from(alertIncidents)
							.where(
								and(
									inArray(alertIncidents.orgId, orgIds),
									inArray(alertIncidents.ruleId, ruleIds),
									eq(alertIncidents.status, "open"),
								),
							),
					])
					return { stateRows, incidentRows }
				})

				const stateByGroup = MutableHashMap.fromIterable(
					Arr.map(
						stateRows,
						(state) => [groupCacheKey(state.orgId, state.ruleId, state.groupKey), state] as const,
					),
				)

				// `groupKey` is nullable on this table. The per-group lookup replaces an
				// `eq(groupKey, …)` predicate, and SQL equality never matches NULL, so a
				// null-keyed incident must not be reachable from it — hence the filterMap.
				// The per-rule grouping below keeps them: its consumer coalesces null to
				// the ungrouped key.
				const incidentByGroup = MutableHashMap.fromIterable(
					Arr.filterMap(incidentRows, (incident) =>
						incident.groupKey === null
							? Result.failVoid
							: Result.succeed([
									groupCacheKey(incident.orgId, incident.ruleId, incident.groupKey),
									incident,
								] as const),
					),
				)

				const incidentsByRule = Arr.groupBy(incidentRows, (incident) =>
					ruleCacheKey(incident.orgId, incident.ruleId),
				)

				return {
					stateFor: (orgId, ruleId, groupKey) =>
						Option.getOrNull(
							MutableHashMap.get(stateByGroup, groupCacheKey(orgId, ruleId, groupKey)),
						),
					openIncidentFor: (orgId, ruleId, groupKey) =>
						Option.getOrNull(
							MutableHashMap.get(incidentByGroup, groupCacheKey(orgId, ruleId, groupKey)),
						),
					openIncidentsForRule: (orgId, ruleId) =>
						Record.get(incidentsByRule, ruleCacheKey(orgId, ruleId)).pipe(
							Option.getOrElse(() => EMPTY_INCIDENTS),
						),
				} satisfies TickPrefetch
			})

			/**
			 * Apply the tick's accumulated `alert_rule_states` housekeeping set-based.
			 *
			 * Replaces two per-rule statements that were each gated to touch zero rows
			 * in steady state — cheap in WAL terms, but still a full dial apiece under
			 * `DatabasePgLive`, every rule, every minute. At most three statements per
			 * tick now, and none at all when nothing evaluated.
			 *
			 * `orgId` is in each predicate for the index, not for correctness: rule ids
			 * are globally unique (`alert_rules.id` is the primary key), so the id lists
			 * already scope these to the right tenant. Without it the predicate could
			 * not use the `(org_id, rule_id, group_key)` primary key at all.
			 *
			 * Best-effort by design. Housekeeping must not fail a tick whose real work —
			 * evaluation, incidents, notifications — has already completed. This does
			 * cost per-rule attribution: a failure here is logged for the tick rather
			 * than recorded against the individual rule as it was when inline.
			 */
			const flushRuleStateHousekeeping = Effect.fnUntraced(function* (
				selfHeal: ReadonlyArray<{
					readonly orgId: OrgId
					readonly ruleId: AlertRuleId
					readonly grouped: boolean
				}>,
				clearError: ReadonlyArray<{
					readonly orgId: OrgId
					readonly ruleId: AlertRuleId
				}>,
				timestamp: number,
			) {
				const bestEffort =
					(label: string) => (effect: Effect.Effect<unknown, AlertPersistenceError>) =>
						effect.pipe(
							Effect.tapError((error) =>
								Effect.logWarning(label).pipe(
									Effect.annotateLogs({ message: error.message }),
								),
							),
							Effect.ignore,
						)

				const selfHealOrgIds = Arr.dedupe(Arr.map(selfHeal, (t) => t.orgId))
				// One pass: `partition` returns [excluded, satisfying], so the `Result`
				// failure arm carries the ungrouped ids and the success arm the grouped.
				const [ungroupedRuleIds, groupedRuleIds] = Arr.partition(selfHeal, (t) =>
					t.grouped ? Result.succeed(t.ruleId) : Result.fail(t.ruleId),
				)

				// A grouped rule can never legitimately own an ungrouped state row, and
				// an ungrouped rule can never own a grouped one. Two statements because
				// the two shapes need opposite `group_key` predicates.
				if (groupedRuleIds.length > 0) {
					yield* dbExecute((db) =>
						db
							.delete(alertRuleStates)
							.where(
								and(
									inArray(alertRuleStates.orgId, selfHealOrgIds),
									inArray(alertRuleStates.ruleId, groupedRuleIds),
									eq(alertRuleStates.groupKey, UNGROUPED_GROUP_KEY),
								),
							),
					).pipe(bestEffort("Failed to self-heal ungrouped state rows for grouped rules"))
				}

				if (ungroupedRuleIds.length > 0) {
					yield* dbExecute((db) =>
						db
							.delete(alertRuleStates)
							.where(
								and(
									inArray(alertRuleStates.orgId, selfHealOrgIds),
									inArray(alertRuleStates.ruleId, ungroupedRuleIds),
									ne(alertRuleStates.groupKey, UNGROUPED_GROUP_KEY),
								),
							),
					).pipe(bestEffort("Failed to self-heal grouped state rows for ungrouped rules"))
				}

				// Only rules that evaluated cleanly are listed, so a rule that failed
				// this tick keeps the `lastError` `recordEvaluationFailure` wrote for it.
				if (clearError.length > 0) {
					yield* dbExecute((db) =>
						db
							.update(alertRuleStates)
							.set({ lastError: null, updatedAt: new Date(timestamp) })
							.where(
								and(
									inArray(alertRuleStates.orgId, [
										...Arr.dedupe(Arr.map(clearError, (t) => t.orgId)),
									]),
									inArray(
										alertRuleStates.ruleId,
										Arr.map(clearError, (t) => t.ruleId),
									),
									isNotNull(alertRuleStates.lastError),
								),
							),
					).pipe(bestEffort("Failed to clear stored evaluation errors"))
				}
			})

			const recordEvaluationStatus = (evaluation: EvaluatedRule) =>
				Match.value(evaluation.status).pipe(
					Match.when("breached", () => Metric.update(AlertingMetrics.rulesBreachedTotal, 1)),
					Match.when("healthy", () => Metric.update(AlertingMetrics.rulesHealthyTotal, 1)),
					Match.when("skipped", () => Metric.update(AlertingMetrics.rulesSkippedTotal, 1)),
					Match.exhaustive,
				)

			const runSchedulerTick = Effect.fn("AlertsService.runSchedulerTick")(function* () {
				const tickStart = yield* now
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertRules)
						.where(eq(alertRules.enabled, true))
						.orderBy(asc(alertRules.updatedAt)),
				)
				yield* Metric.update(AlertingMetrics.activeRulesGauge, rows.length)

				const prefetch = yield* loadTickPrefetch(rows)

				// Warm the org warehouse-config memo for the whole tick in one read,
				// before the per-rule forEach below fans out at concurrency 5.
				//
				// Without this, the fan-out is the worst possible shape for that memo:
				// `interleaveAlertRulesByOrg` deliberately puts consecutive rules on
				// DIFFERENT orgs (for fairness), so the five in-flight fibers miss on
				// five different orgs at once and none of them has written the memo yet
				// when the others look. Measured at 13,989 Postgres resolutions/day at
				// p50 632ms — ~2.4 hours of blocked wall time — against a 94% memo hit
				// rate, i.e. the misses are concurrency, not cache sizing.
				//
				// Best-effort: priming is an optimization, and a failure here must not
				// take down a tick that would otherwise resolve each config on demand.
				yield* orgChSettings
					.primeRuntimeConfigs(Arr.dedupe(Arr.map(rows, (row) => row.orgId)))
					.pipe(Effect.ignore)

				// Incremented from fibers running under the concurrent per-rule forEach
				// below, so it must be a Ref rather than a mutable closure variable.
				const evaluationFailureCount = yield* Ref.make(0)
				// Chunk makes concurrent appends immutable without copying the full buffer.
				const pendingChecks = yield* Ref.make(Chunk.empty<AlertChecksRow>())
				const issueBudget = yield* Ref.make(ISSUE_UPSERTS_PER_TICK)

				// Two housekeeping statements used to run per rule, inside the loop.
				// Both are gated to touch zero rows in steady state (to keep the
				// Electric shape quiet), but a zero-row statement still costs a full
				// dial under `DatabasePgLive` — ~2 dials × every rule × every minute.
				// The rules they need are accumulated here and applied set-based once
				// per tick instead. Refs for the same reason as `evaluationFailureCount`:
				// the forEach below runs at concurrency 5.
				//
				// Deliberately separate lists, because the two statements do not cover
				// the same rules: the self-heal delete is skipped on the multi-service
				// path (which returns early), while the error clear applies to every
				// rule that evaluated cleanly.
				const selfHealTargets = yield* Ref.make(
					Chunk.empty<{
						readonly orgId: OrgId
						readonly ruleId: AlertRuleId
						readonly grouped: boolean
					}>(),
				)
				const clearErrorTargets = yield* Ref.make(
					Chunk.empty<{
						readonly orgId: OrgId
						readonly ruleId: AlertRuleId
					}>(),
				)

				const recordEvaluationFailure = Effect.fnUntraced(function* (
					row: AlertRuleRow,
					error:
						| AlertValidationError
						| AlertDeliveryFailure
						| AlertPersistenceError
						| AlertRuleStoredConfigInvalidError
						| QueryEngineValidationError
						| QueryEngineTimeoutError
						| WarehouseQueryPathError,
					failureCategory: string,
					fields?: {
						readonly upstreamStatus?: number
						readonly quotaSetting?: string
						readonly pipe?: string
					},
				) {
					yield* Ref.update(evaluationFailureCount, (count) => count + 1)
					yield* Metric.update(AlertingMetrics.evaluationFailuresTotal, 1)
					yield* Effect.logError("Alert rule evaluation failed").pipe(
						Effect.annotateLogs({
							workerId,
							ruleId: row.id,
							orgId: row.orgId,
							failureCategory,
							errorMessage: error.message,
							upstreamStatus: fields?.upstreamStatus,
							quotaSetting: fields?.quotaSetting,
							pipe: fields?.pipe,
						}),
					)

					const failedAt = yield* now
					const message = error.message.slice(0, 500)

					// Audit row: a failed evaluation is a check that produced no
					// observation — record it so the check history has no silent gaps.
					yield* Ref.update(
						pendingChecks,
						Chunk.append({
							OrgId: row.orgId,
							RuleId: row.id,
							GroupKey: UNGROUPED_GROUP_KEY,
							Timestamp: toIngestDateTime64(failedAt),
							Status: "error",
							SignalType: row.signalType,
							Comparator: row.comparator,
							Threshold: row.threshold,
							ObservedValue: null,
							SampleCount: 0,
							WindowMinutes: row.windowMinutes,
							WindowStart: toIngestDateTime64(failedAt - row.windowMinutes * 60_000),
							WindowEnd: toIngestDateTime64(failedAt),
							ConsecutiveBreaches: 0,
							ConsecutiveHealthy: 0,
							IncidentId: null,
							IncidentTransition: "none",
							EvaluationDurationMs: 0,
							ErrorMessage: message,
							ErrorCategory: failureCategory,
						}),
					)

					// Persist the failure to alert_rule_states so listRules/Electric can
					// surface it. Churn-gated (the states shape is Electric-synced): skip
					// when the same message was written within the heartbeat window, and
					// never clobber the state-machine counters in the conflict set.
					// Best-effort: recording a failure must not itself fail the tick.
					yield* Effect.gen(function* () {
						const state =
							(yield* dbExecute((db) =>
								db
									.select({
										lastError: alertRuleStates.lastError,
										lastEvaluatedAt: alertRuleStates.lastEvaluatedAt,
									})
									.from(alertRuleStates)
									.where(
										and(
											eq(alertRuleStates.orgId, row.orgId),
											eq(alertRuleStates.ruleId, row.id),
											eq(alertRuleStates.groupKey, UNGROUPED_GROUP_KEY),
										),
									)
									.limit(1),
							))[0] ?? null
						const unchanged =
							state != null &&
							state.lastError === message &&
							state.lastEvaluatedAt != null &&
							failedAt - state.lastEvaluatedAt.getTime() < STATE_HEARTBEAT_MS
						if (unchanged) return
						yield* dbExecute((db) =>
							db
								.insert(alertRuleStates)
								.values({
									orgId: row.orgId,
									ruleId: row.id,
									groupKey: UNGROUPED_GROUP_KEY,
									consecutiveBreaches: 0,
									consecutiveHealthy: 0,
									lastStatus: null,
									lastValue: null,
									lastSampleCount: null,
									lastEvaluatedAt: new Date(failedAt),
									lastError: message,
									updatedAt: new Date(failedAt),
								})
								.onConflictDoUpdate({
									target: [
										alertRuleStates.orgId,
										alertRuleStates.ruleId,
										alertRuleStates.groupKey,
									],
									set: {
										lastError: message,
										lastEvaluatedAt: new Date(failedAt),
										updatedAt: new Date(failedAt),
									},
								}),
						)
					}).pipe(
						Effect.tapError((persistError) =>
							Effect.logWarning("Failed to persist alert evaluation error").pipe(
								Effect.annotateLogs({
									ruleId: row.id,
									message: persistError.message,
								}),
							),
						),
						Effect.ignore,
					)
				})

				yield* Effect.forEach(
					interleaveAlertRulesByOrg(rows),
					(row) =>
						Effect.gen(function* () {
							const timestamp = yield* now
							const claimed = yield* claimAndTouchRule(row.orgId, row.id, timestamp)
							if (claimed.length === 0) return

							yield* Effect.gen(function* () {
								const ruleStart = yield* now
								const normalized = yield* normalizeRuleRow(row)

								if (normalized.serviceNames.length > 1) {
									yield* Effect.forEach(normalized.serviceNames, (svcName) =>
										Effect.gen(function* () {
											const perServicePlan = yield* compileRulePlan({
												...normalized,
												serviceName: svcName,
											})
											const perService = {
												...normalized,
												serviceName: svcName,
												compiledPlan: perServicePlan,
											}
											const observations = yield* evaluateRule(row.orgId, perService)
											const evaluation = observations[0]?.evaluation
											if (evaluation == null) return
											yield* recordEvaluationStatus(evaluation)
											yield* processEvaluation(
												row,
												normalized,
												evaluation,
												svcName,
												timestamp,
												pendingChecks,
												issueBudget,
												prefetch,
											)
										}),
									)

									yield* resolveOrphanedGroupIncidents(
										row.orgId,
										normalized.id,
										normalized,
										HashSet.fromIterable(normalized.serviceNames),
										timestamp,
										prefetch.openIncidentsForRule(row.orgId, row.id),
									)
									yield* Metric.update(
										AlertingMetrics.ruleEvaluationDurationMs,
										(yield* now) - ruleStart,
									)
									return
								}

								// Uniform grouped/ungrouped path. `evaluateRule` returns one
								// outcome per group already keyed in storage vocabulary — a single
								// UNGROUPED_GROUP_KEY entry (with a no-data fallback) when the
								// compiled plan is ungrouped — so both shapes flow through the
								// same loop with no key translation here.
								const grouped = isGroupedPlan(normalized.compiledPlan)
								const results = yield* evaluateRule(row.orgId, normalized)
								const excludeSet = HashSet.fromIterable(normalized.excludeServiceNames)
								const eligible = grouped
									? Arr.filter(results, (r) => !HashSet.has(excludeSet, r.groupKey))
									: results

								yield* Effect.forEach(eligible, ({ evaluation, groupKey }) =>
									Effect.gen(function* () {
										yield* recordEvaluationStatus(evaluation)
										yield* processEvaluation(
											row,
											normalized,
											evaluation,
											groupKey,
											timestamp,
											pendingChecks,
											issueBudget,
											prefetch,
										)
									}),
								)

								const evaluatedGroups = HashSet.fromIterable(
									Arr.map(eligible, (r) => r.groupKey),
								)
								yield* resolveOrphanedGroupIncidents(
									row.orgId,
									normalized.id,
									normalized,
									evaluatedGroups,
									timestamp,
									prefetch.openIncidentsForRule(row.orgId, row.id),
								)

								// Self-heal state rows whose key shape contradicts the rule's
								// groupedness: a grouped rule can never legitimately own an
								// ungrouped row (left behind when this rule evaluated ungrouped,
								// or by recordEvaluationFailure), and vice versa. Orphan resolution
								// above only deletes incident-backed rows. Zero rows touched in
								// steady state, so the Electric shape stays quiet.
								//
								// Applied set-based after the loop (see `flushSelfHeal`). Safe to
								// defer: it is scoped to this rule and this rule's own writes are
								// already done, so end-of-tick is the same state it would have seen
								// here.
								yield* Ref.update(
									selfHealTargets,
									Chunk.append({ orgId: row.orgId, ruleId: row.id, grouped }),
								)

								yield* Metric.update(
									AlertingMetrics.ruleEvaluationDurationMs,
									(yield* now) - ruleStart,
								)
							}).pipe(
								// The rule evaluated cleanly — clear any stored evaluation error.
								// Conditional on lastError IS NOT NULL so healthy steady-state
								// ticks touch zero rows (no Electric shape churn). This also
								// covers grouped/multi-service rules, whose "__total__" error row
								// is never revisited by upsertState.
								//
								// Accumulated and applied set-based after the loop. Only rules that
								// reach here are cleared, so a rule that failed this tick keeps the
								// `lastError` that `recordEvaluationFailure` just wrote for it.
								Effect.tap(() =>
									Ref.update(
										clearErrorTargets,
										Chunk.append({ orgId: row.orgId, ruleId: row.id }),
									),
								),
								Effect.catch((error) =>
									recordEvaluationFailure(
										row,
										error,
										error.error.code,
										"pipeName" in error
											? {
													pipe: error.pipeName,
													...(error._tag ===
													"@maple/http/errors/WarehouseQuotaExceededError"
														? { quotaSetting: error.setting }
														: {}),
													...(error._tag ===
														"@maple/http/errors/WarehouseUpstreamError" ||
													error._tag === "@maple/http/errors/WarehouseAuthError"
														? { upstreamStatus: error.upstreamStatus }
														: {}),
												}
											: undefined,
									),
								),
							)
						}),
					{ concurrency: 5 },
				)

				yield* flushRuleStateHousekeeping(
					Chunk.toReadonlyArray(yield* Ref.get(selfHealTargets)),
					Chunk.toReadonlyArray(yield* Ref.get(clearErrorTargets)),
					tickStart,
				)

				// Resolve stale incidents for disabled rules
				const disabledRulesWithOpenIncidents = yield* dbExecute((db) =>
					db
						.selectDistinct({
							ruleId: alertIncidents.ruleId,
							orgId: alertIncidents.orgId,
						})
						.from(alertIncidents)
						.innerJoin(alertRules, eq(alertIncidents.ruleId, alertRules.id))
						.where(and(eq(alertIncidents.status, "open"), eq(alertRules.enabled, false))),
				)
				yield* Effect.forEach(disabledRulesWithOpenIncidents, ({ ruleId, orgId }) =>
					Effect.gen(function* () {
						const ruleRow = (yield* dbExecute((db) =>
							db.select().from(alertRules).where(eq(alertRules.id, ruleId)).limit(1),
						))[0]
						if (!ruleRow) return
						const normalized = yield* normalizeRuleRow(ruleRow)
						yield* resolveStaleIncidents(orgId, normalized.id, normalized, {
							resolveAll: true,
						})
					}),
				)

				// Flush accumulated alert_check audit rows to Tinybird, one POST per
				// orgId. Awaited so the Cloudflare Worker isolate stays alive until
				// the writes complete; errors are logged then swallowed because the
				// authoritative state already lives in Postgres above.
				const accumulatedChecks = yield* Ref.getAndSet(pendingChecks, Chunk.empty())
				if (accumulatedChecks.length > 0) {
					const byOrg = new Map<string, AlertChecksRow[]>()
					for (const check of accumulatedChecks) {
						const bucket = byOrg.get(check.OrgId)
						if (bucket) bucket.push(check)
						else byOrg.set(check.OrgId, [check])
					}
					yield* Effect.forEach(
						Array.from(byOrg.entries()),
						([orgId, checks]) =>
							// Not metered to Autumn: internal bookkeeping rows, not customer
							// telemetry.
							warehouse
								.ingest(systemTenant(decodeOrgIdSync(orgId)), "alert_checks", checks)
								.pipe(
									Effect.tapCause((cause) =>
										Effect.logWarning("Failed to ingest alert_checks audit rows").pipe(
											Effect.annotateLogs({
												orgId,
												rowCount: checks.length,
												cause: Cause.pretty(cause),
											}),
										),
									),
									Effect.ignore,
								),
						{ concurrency: ALERT_CHECK_INGEST_CONCURRENCY },
					)
				}

				const deliveryResult = yield* processQueuedDeliveries()
				yield* Metric.update(AlertingMetrics.rulesEvaluatedTotal, rows.length)
				yield* Metric.update(AlertingMetrics.tickDurationMs, (yield* now) - tickStart)
				return {
					evaluatedCount: rows.length,
					processedCount: deliveryResult.processedCount,
					evaluationFailureCount: yield* Ref.get(evaluationFailureCount),
					deliveryFailureCount: deliveryResult.failureCount,
				}
			})

			// `AlertsService.of(...)` can't be used here — referencing the class inside
			// its own `make` is a TS2506 circular base-expression error.
			return {
				listDestinations: destinations.listDestinations,
				createDestination: destinations.createDestination,
				updateDestination: destinations.updateDestination,
				deleteDestination: destinations.deleteDestination,
				testDestination: destinations.testDestination,
				listRules: rules.listRules,
				createRule: rules.createRule,
				updateRule,
				deleteRule: rules.deleteRule,
				testRule,
				previewRule,
				listIncidents: readModels.listIncidents,
				getIncident: readModels.getIncident,
				listRuleChecks: readModels.listRuleChecks,
				summarizeRuleChecks: readModels.summarizeRuleChecks,
				listDeliveryEvents: readModels.listDeliveryEvents,
				runSchedulerTick,
			} satisfies AlertsServiceShape
		}),
	},
) {
	// The resolver remains private to alert delivery; the destination capability
	// is explicit so composition roots can expose it without the evaluator graph.
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SlackBotTokenResolver.layer))
}
