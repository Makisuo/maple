import { randomUUID } from "node:crypto"
import {
	CompiledAlertQueryPlan,
	QueryEngineAlertReducer,
	QueryEngineNoDataBehavior,
	type QueryEngineSampleCountStrategy,
	QuerySpec,
} from "@maple/query-engine"
import * as CH from "@maple/query-engine/ch"
import { buildTimeseriesQuerySpec, resolveGroupBy } from "@maple/query-engine/query-builder"
import {
	AlertComparator as AlertComparatorSchema,
	AlertDeliveryError,
	AlertDeliveryEventDocument,
	AlertDeliveryEventsListResponse,
	AlertDeliveryStatus,
	AlertDestinationDeleteResponse,
	AlertDestinationDocument,
	AlertDestinationInUseError,
	AlertDestinationTestResponse,
	AlertDestinationsListResponse,
	AlertEvaluationResult,
	AlertEventType as AlertEventTypeSchema,
	AlertForbiddenError,
	AlertGroupBy as AlertGroupBySchema,
	AlertCheckDocument,
	AlertChecksListResponse,
	AlertCheckStatus as AlertCheckStatusSchema,
	AlertEvaluationStatus as AlertEvaluationStatusSchema,
	AlertIncidentDocument,
	AlertIncidentsListResponse,
	AlertIncidentStatus,
	AlertIncidentTransition as AlertIncidentTransitionSchema,
	AlertMetricAggregation as AlertMetricAggregationSchema,
	AlertMetricType as AlertMetricTypeSchema,
	AlertNotFoundError,
	AlertPersistenceError,
	AlertRuleDeleteResponse,
	AlertRuleDocument,
	AlertRulePreviewFiringSpan,
	AlertRulePreviewPoint,
	AlertRulePreviewResponse,
	AlertRulePreviewSeries,
	type AlertRulePreviewRequest,
	AlertRulesListResponse,
	AlertSeverity as AlertSeveritySchema,
	AlertSignalType as AlertSignalTypeSchema,
	AlertValidationError,
	QueryBuilderQueryDraftSchema,
	AlertNotificationTemplate,
	type AlertComparator,
	AlertDestinationType as AlertDestinationTypeSchema,
	type AlertDestinationCreateRequest,
	type AlertDestinationType,
	type AlertDestinationUpdateRequest,
	type AlertEventType as AlertEventTypeValue,
	type AlertMetricAggregation as AlertMetricAggregationValue,
	type AlertMetricType,
	type AlertRuleUpsertRequest,
	type QueryBuilderQueryDraftPayload,
	type AlertSeverity,
	type AlertSignalType,
	type AlertGroupBy,
	OrgId,
	type AlertRuleId,
	type AlertDestinationId,
	type AlertIncidentId,
	QueryEngineExecutionError,
	type WarehouseError,
	QueryEngineTimeoutError,
	QueryEngineValidationError,
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
	alertRules,
	type AlertRuleRow,
	alertRuleStates,
} from "@maple/db"
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Effect,
	HashSet,
	Layer,
	Match,
	Metric,
	Option,
	Random,
	Redacted,
	Ref,
	Schema,
	Context,
} from "effect"
import * as AlertingMetrics from "../lib/AlertingMetrics"
import { AI_TRIAGE_WORKFLOW_BINDING } from "../lib/ai-triage-enqueue"
import { upsertAlertIssue } from "../lib/issue-hub"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import type { TenantContext } from "./AuthService"
import {
	decryptAes256Gcm,
	encryptAes256Gcm,
	parseBase64Aes256GcmKey,
	type EncryptedValue,
} from "../lib/Crypto"
import { Database, type DatabaseClient } from "../lib/DatabaseLive"
import { readTxid, txidColumn } from "../lib/electric-txid"
import {
	buildAlertChatUrl,
	dispatchDelivery as dispatchDeliveryImpl,
	formatComparator,
	PAGERDUTY_ROUTING_KEY_PATTERN,
	verifyPagerDutyRoutingKey,
} from "./AlertDeliveryDispatch"
import { Env } from "../lib/Env"
import { describeCause } from "./ErrorsService"
import { HazelOAuthService } from "./HazelOAuthService"
import { QueryEngineService } from "./QueryEngineService"
import type { GroupedAlertObservation } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { validateExternalUrl } from "../lib/url-validator"
import type { AlertChecksRow } from "@maple/domain/tinybird"
import {
	PublicConfigFromJson,
	SecretConfigFromJson,
	type DestinationPublicConfig,
	type DestinationSecretConfig,
	type EnrichedDestinationSecretConfig,
} from "./AlertDestinationHydration"
import { dateToMs } from "../lib/time"

interface NormalizedRule {
	readonly id: AlertRuleId
	readonly name: string
	readonly notificationTemplate: AlertNotificationTemplate | null
	readonly enabled: boolean
	readonly severity: AlertSeverity
	readonly serviceName: string | null
	readonly serviceNames: ReadonlyArray<string>
	readonly excludeServiceNames: ReadonlyArray<string>
	readonly tags: ReadonlyArray<string>
	readonly groupBy: AlertGroupBy | null
	readonly signalType: AlertSignalType
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly windowMinutes: number
	readonly minimumSampleCount: number
	readonly consecutiveBreachesRequired: number
	readonly consecutiveHealthyRequired: number
	readonly renotifyIntervalMinutes: number
	readonly metricName: string | null
	readonly metricType: AlertMetricType | null
	readonly metricAggregation: AlertMetricAggregationValue | null
	readonly apdexThresholdMs: number | null
	readonly queryBuilderDraft: QueryBuilderQueryDraftPayload | null
	readonly rawQuerySql: string | null
	readonly rawQueryReducer: QueryEngineAlertReducer | null
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
	readonly compiledPlan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>
	readonly createdAt: number
	readonly updatedAt: number
}

interface EvaluatedRule {
	readonly status: Schema.Schema.Type<typeof AlertEvaluationResult.fields.status>
	readonly value: number | null
	readonly sampleCount: number
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly comparator: AlertComparator
	readonly reason: string
}

interface DispatchContext {
	readonly deliveryKey: string
	readonly destination: AlertDestinationRow
	readonly publicConfig: DestinationPublicConfig
	readonly secretConfig: EnrichedDestinationSecretConfig
	readonly ruleId: AlertRuleId
	readonly ruleName: string
	readonly groupKey: string | null
	readonly signalType: AlertSignalType
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly eventType: AlertEventTypeValue
	readonly incidentId: AlertIncidentId | null
	readonly incidentStatus: Schema.Schema.Type<typeof AlertIncidentStatus>
	readonly dedupeKey: string
	readonly windowMinutes: number
	readonly value: number | null
	readonly sampleCount: number | null
	readonly linkUrl: string
	readonly sentAtMs: number
	readonly template?: AlertNotificationTemplate | null
}

interface DispatchResult {
	readonly providerMessage: string | null
	readonly providerReference: string | null
	readonly responseCode: number | null
}

interface DeliveryPayloadContext {
	readonly eventType: AlertEventTypeValue
	readonly incidentId: AlertIncidentId | null
	readonly incidentStatus: Schema.Schema.Type<typeof AlertIncidentStatus>
	readonly dedupeKey: string
	readonly ruleId: AlertRuleId
	readonly ruleName: string
	readonly groupKey: string | null
	readonly signalType: AlertSignalType
	readonly severity: AlertSeverity
	readonly comparator: AlertComparator
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly windowMinutes: number
	readonly value: number | null
	readonly sampleCount: number | null
	readonly linkUrl: string
	readonly sentAtMs: number
	readonly template?: AlertNotificationTemplate | null
}

interface DeliveryAttemptFailure {
	readonly message: string
	readonly kind: "transport" | "timeout" | "payload" | "destination" | "unknown"
	readonly retryable: boolean
}

const MAX_DELIVERY_ATTEMPTS = 5
// Storm fuse: cap issue-hub upserts per scheduler tick so a pathological
// group-by rule opening hundreds of incidents can't stall the per-minute tick.
const ISSUE_UPSERTS_PER_TICK = 50
const DELIVERY_TIMEOUT_MS_DEFAULT = 15_000
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

const StringArraySchema = Schema.Array(Schema.String)
const DestinationIdArraySchema = Schema.Array(AlertDestinationDocument.fields.id)

const AlertGroupByFromJson = Schema.fromJsonString(AlertGroupBySchema)

const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.id)
const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)
const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)
const decodeAlertDestinationTypeSync = Schema.decodeUnknownSync(AlertDestinationTypeSchema)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeAlertEvaluationStatusSync = Schema.decodeUnknownSync(AlertEvaluationStatusSchema)
const decodeAlertCheckStatusSync = Schema.decodeUnknownSync(AlertCheckStatusSchema)
const decodeAlertIncidentTransitionSync = Schema.decodeUnknownSync(AlertIncidentTransitionSchema)
const decodeAlertMetricTypeSync = Schema.decodeUnknownSync(AlertMetricTypeSchema)
const decodeAlertMetricAggregationSync = Schema.decodeUnknownSync(AlertMetricAggregationSchema)
const decodeAlertIncidentStatusSync = Schema.decodeUnknownSync(AlertIncidentStatus)
const decodeAlertEventTypeSync = Schema.decodeUnknownSync(AlertEventTypeSchema)
const decodeErrorIssueIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.errorIssueId)
const decodeAlertDeliveryStatusSync = Schema.decodeUnknownSync(AlertDeliveryStatus)

const decodeAlertGroupByFromJsonSync = Schema.decodeUnknownSync(AlertGroupByFromJson)
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)

const parseStoredGroupBy = (raw: string | null): AlertGroupBy | null =>
	raw == null ? null : decodeAlertGroupByFromJsonSync(raw)

const isServiceGroupBy = (groupBy: AlertGroupBy | null): boolean =>
	groupBy != null && groupBy.length === 1 && groupBy[0] === "service.name"

/**
 * The compiled plan is the single authority on whether a rule evaluates
 * grouped. Rule-level `groupBy` and a builder draft's `groupBy` both funnel
 * into the compiled spec's tokens (`["none"]` when ungrouped), so evaluation
 * code must never consult those source representations — a builder_query rule
 * stores its grouping only in the draft and keeps rule-level `groupBy` null.
 */
const planGroupingTokens = (
	plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>,
): ReadonlyArray<string> | null => {
	if (plan.kind !== "spec" || plan.query == null || plan.query.kind !== "timeseries") return null
	const groupBy = plan.query.groupBy
	if (groupBy == null || groupBy.length === 0 || groupBy.includes("none")) return null
	return groupBy
}

const isGroupedPlan = (plan: Schema.Schema.Type<typeof CompiledAlertQueryPlan>): boolean =>
	planGroupingTokens(plan) != null

const resolveServiceLinkName = (
	rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
	groupKey: string | null,
): string | null => {
	if (rule.serviceNames.length === 1) return rule.serviceNames[0] ?? null
	if (groupKey != null && groupKey !== "all" && isServiceGroupBy(rule.groupBy)) {
		return groupKey
	}
	return null
}
const decodeQueryEngineAlertReducerSync = Schema.decodeUnknownSync(QueryEngineAlertReducer)
const decodeNoDataBehaviorSync = Schema.decodeUnknownSync(QueryEngineNoDataBehavior)

/** Parse the stored query-builder draft value; returns null when absent/invalid. */
const parseStoredQueryBuilderDraft = (raw: unknown): QueryBuilderQueryDraftPayload | null => {
	if (raw == null) return null
	return Option.getOrElse(Schema.decodeUnknownOption(QueryBuilderQueryDraftSchema)(raw), () => null)
}

/** Parse the stored notification-template value; returns null when absent/invalid. */
const parseStoredNotificationTemplate = (raw: unknown): AlertNotificationTemplate | null => {
	if (raw == null) return null
	return Option.getOrElse(Schema.decodeUnknownOption(AlertNotificationTemplate)(raw), () => null)
}

type IsoDateTimeValue = Schema.Schema.Type<typeof AlertDestinationDocument.fields.createdAt>

const adminRoles = [decodeRoleNameSync("root"), decodeRoleNameSync("org:admin")]

export interface AlertRuntimeShape {
	/** Current wall-clock time in epoch ms, sourced from Effect's `Clock` so tests drive it via `TestClock`. */
	readonly now: Effect.Effect<number>
	readonly makeUuid: () => string
	readonly fetch: typeof fetch
	readonly deliveryTimeoutMs: () => number
}

export class AlertRuntime extends Context.Reference<AlertRuntimeShape>("@maple/api/services/AlertRuntime", {
	defaultValue: (): AlertRuntimeShape => ({
		now: Clock.currentTimeMillis,
		makeUuid: () => randomUUID(),
		fetch: globalThis.fetch,
		deliveryTimeoutMs: () => DELIVERY_TIMEOUT_MS_DEFAULT,
	}),
}) {
	// Reference defaults make explicit wiring optional; kept for hosts that
	// still merge it into their layer stack.
	static readonly layer = Layer.succeed(this, this.defaultValue())
}

const toIso = (value: Date | null | undefined): IsoDateTimeValue | null =>
	value == null ? null : decodeIsoDateTimeStringSync(value.toISOString())

// Caps on how many evaluation windows a rule preview replays. Spec plans cost
// one CH query regardless of bucket count; raw-SQL plans run one query per
// window, so they get a tighter cap.
const MAX_PREVIEW_BUCKETS = 200
const MAX_RAW_PREVIEW_WINDOWS = 60

// Tinybird DateTime64(3) wire format for alert_checks ingest:
// "YYYY-MM-DD HH:MM:SS.SSS" (UTC, no timezone).
const toIngestDateTime64 = (epochMs: number) => {
	const d = new Date(epochMs)
	const pad = (n: number, w = 2) => n.toString().padStart(w, "0")
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

const toTinybirdDateTime = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

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

const normalizeOptionalString = (value: string | null | undefined) => {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

const makePersistenceError = (error: unknown) => {
	const cause = describeCause(error instanceof Error ? error.cause : error)
	return new AlertPersistenceError({
		message: error instanceof Error ? error.message : "Alert persistence failed",
		...(cause === undefined ? {} : { cause }),
	})
}

const makeValidationError = (message: string, details: ReadonlyArray<string> = [], cause?: unknown) =>
	new AlertValidationError({ message, details, ...(cause === undefined ? {} : { cause }) })

const makeDeliveryError = (message: string, destinationType?: AlertDestinationType) =>
	new AlertDeliveryError({
		message,
		destinationType,
	})

const isAdmin = (roles: ReadonlyArray<RoleName>) => roles.some((role) => adminRoles.includes(role))

const validateDestinationUrl = (rawUrl: string, field: string): Effect.Effect<string, AlertValidationError> =>
	validateExternalUrl(rawUrl).pipe(
		Effect.as(rawUrl.trim()),
		Effect.mapError((error) => makeValidationError(`${field}: ${error.message}`)),
	)

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, AlertValidationError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		makeValidationError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const encryptSecret = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, AlertValidationError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () =>
		makeValidationError("Failed to encrypt destination secret"),
	)

const decryptSecret = (
	encrypted: {
		secretCiphertext: string
		secretIv: string
		secretTag: string
	},
	encryptionKey: Buffer,
): Effect.Effect<string, AlertValidationError> =>
	decryptAes256Gcm(
		{
			ciphertext: encrypted.secretCiphertext,
			iv: encrypted.secretIv,
			tag: encrypted.secretTag,
		},
		encryptionKey,
		() => makeValidationError("Failed to decrypt destination secret"),
	)

const parsePublicConfig = (
	row: AlertDestinationRow,
): Effect.Effect<DestinationPublicConfig, AlertValidationError> =>
	Schema.decodeUnknownEffect(PublicConfigFromJson)(JSON.stringify(row.configJson)).pipe(
		Effect.mapError((cause) => makeValidationError("Stored destination config is invalid", [], cause)),
	)

const parseSecretConfig = (json: string): Effect.Effect<DestinationSecretConfig, AlertValidationError> =>
	Schema.decodeUnknownEffect(SecretConfigFromJson)(json).pipe(
		Effect.mapError((cause) => makeValidationError("Stored destination secret is invalid", [], cause)),
	)

type StoredDeliveryPayloadType = Schema.Schema.Type<typeof StoredDeliveryPayloadSchema>

const parseDeliveryPayload = (value: unknown): Effect.Effect<StoredDeliveryPayloadType, AlertValidationError> =>
	Schema.decodeUnknownEffect(StoredDeliveryPayloadSchema)(value).pipe(
		Effect.mapError((cause) => makeValidationError("Stored delivery payload is invalid", [], cause)),
	)

const summarizeWebhookUrl = (url: string) =>
	Option.match(Option.liftThrowable(() => new URL(url))(), {
		onNone: () => "Webhook endpoint",
		onSome: (parsed) => `POST ${parsed.host}`,
	})

const buildPublicConfig = (request: AlertDestinationCreateRequest): DestinationPublicConfig =>
	Match.value(request).pipe(
		Match.discriminatorsExhaustive("type")({
			slack: (r) => ({
				summary: r.channelLabel?.trim() || "Slack incoming webhook",
				channelLabel: normalizeOptionalString(r.channelLabel),
			}),
			pagerduty: () => ({
				summary: "PagerDuty Events API v2" as string,
				channelLabel: null,
			}),
			webhook: (r) => ({
				summary: summarizeWebhookUrl(r.url),
				channelLabel: null,
			}),
			hazel: (r) => ({
				summary: summarizeWebhookUrl(r.webhookUrl),
				channelLabel: null,
			}),
			"hazel-oauth": (r) => ({
				summary: `${r.hazelOrganizationName} · #${r.hazelChannelName}`,
				channelLabel: `#${r.hazelChannelName}`,
				hazelOrganizationId: r.hazelOrganizationId,
				hazelOrganizationName: r.hazelOrganizationName,
				hazelOrganizationLogoUrl: r.hazelOrganizationLogoUrl ?? null,
				hazelChannelId: r.hazelChannelId,
				hazelChannelName: r.hazelChannelName,
			}),
			discord: (r) => ({
				summary: summarizeWebhookUrl(r.webhookUrl),
				channelLabel: null,
			}),
		}),
	)

const buildSecretConfig = (request: AlertDestinationCreateRequest): DestinationSecretConfig =>
	Match.value(request).pipe(
		Match.discriminatorsExhaustive("type")({
			slack: (r) => ({
				type: "slack" as const,
				webhookUrl: r.webhookUrl.trim(),
			}),
			pagerduty: (r) => ({
				type: "pagerduty" as const,
				integrationKey: r.integrationKey.trim(),
			}),
			webhook: (r) => ({
				type: "webhook" as const,
				url: r.url.trim(),
				signingSecret: normalizeOptionalString(r.signingSecret),
			}),
			hazel: (r) => ({
				type: "hazel" as const,
				webhookUrl: r.webhookUrl.trim(),
				signingSecret: normalizeOptionalString(r.signingSecret),
			}),
			// Hazel-OAuth requires provisioning a channel webhook on Hazel; we build
			// the secret config inline after that side effect, not here.
			"hazel-oauth": () => {
				throw new Error(
					"Hazel-OAuth secret config must be built via the channel-webhook provisioning path",
				)
			},
			discord: (r) => ({
				type: "discord" as const,
				webhookUrl: r.webhookUrl.trim(),
			}),
		}),
	)

const safeParsePublicConfig = (row: AlertDestinationRow): DestinationPublicConfig =>
	Option.getOrElse(Schema.decodeUnknownOption(PublicConfigFromJson)(JSON.stringify(row.configJson)), () => ({
		summary: "Invalid destination config",
		channelLabel: null,
	}))

const safeParseStringArray = (value: unknown): ReadonlyArray<string> =>
	Option.getOrElse(
		Schema.decodeUnknownOption(StringArraySchema)(value),
		() => [] as ReadonlyArray<string>,
	)

const compileRulePlan = Effect.fn("AlertsService.compileRulePlan")(function* (rule: {
	readonly signalType: AlertSignalType
	readonly serviceName: string | null
	readonly metricName: string | null
	readonly metricType: AlertMetricType | null
	readonly metricAggregation: AlertMetricAggregationValue | null
	readonly apdexThresholdMs: number | null
	readonly queryBuilderDraft: QueryBuilderQueryDraftPayload | null
	readonly rawQuerySql: string | null
	readonly rawQueryReducer: QueryEngineAlertReducer | null
	readonly comparator: AlertComparator
	readonly windowMinutes: number
	readonly groupBy: AlertGroupBy | null
}): Effect.fn.Return<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertValidationError> {
	const bucketSeconds = Math.max(rule.windowMinutes * 60, 60)
	const baseTraceFilters = rule.serviceName == null ? undefined : { serviceName: rule.serviceName }

	const noDataBehavior: QueryEngineNoDataBehavior =
		rule.signalType === "throughput" && ["lt", "lte"].includes(rule.comparator) ? "zero" : "skip"

	const traceSignalMetrics: Record<string, string> = {
		error_rate: "error_rate",
		p95_latency: "p95_duration",
		p99_latency: "p99_duration",
		throughput: "count",
		apdex: "apdex",
	}

	/**
	 * Resolve the rule's user-facing group_by tokens (e.g. ["service.name",
	 * "attr.http.route"]) into the internal QuerySpec representation. Returns
	 * null when there is no grouping (the spec then uses ["none"]).
	 */
	const resolveRuleGroupBy = (
		source: "traces" | "logs" | "metrics",
	): Effect.Effect<
		{
			tokens: ReadonlyArray<string>
			attributeKeys: ReadonlyArray<string>
			resourceAttributeKeys: ReadonlyArray<string>
		} | null,
		AlertValidationError
	> => {
		if (rule.groupBy == null || rule.groupBy.length === 0) return Effect.succeed(null)
		const resolved = resolveGroupBy(source, rule.groupBy)
		if (resolved.warnings.length > 0) {
			return Effect.fail(
				makeValidationError(`Invalid groupBy for ${source} alert`, [...resolved.warnings]),
			)
		}
		if (resolved.tokens.length === 0) {
			return Effect.fail(
				makeValidationError(`groupBy did not resolve to any usable dimension for ${source}`),
			)
		}
		if (source === "metrics" && resolved.attributeKeys.length > 1) {
			return Effect.fail(
				makeValidationError(
					"Metrics alerts support at most one attr.* groupBy dimension",
					resolved.attributeKeys.map(
						(key) => `Unsupported additional metrics groupBy attribute: ${key}`,
					),
				),
			)
		}
		if (source === "metrics" && resolved.resourceAttributeKeys.length > 1) {
			return Effect.fail(
				makeValidationError(
					"Metrics alerts support at most one resource.* groupBy dimension",
					resolved.resourceAttributeKeys.map(
						(key) => `Unsupported additional metrics groupBy resource attribute: ${key}`,
					),
				),
			)
		}
		if (
			source === "metrics" &&
			resolved.attributeKeys.length > 0 &&
			resolved.resourceAttributeKeys.length > 0
		) {
			// The metrics queries carry a single attribute group column — the
			// engine rejects combining both dimensions, so fail at compile time.
			return Effect.fail(
				makeValidationError("Metrics alerts cannot combine attr.* and resource.* groupBy dimensions"),
			)
		}
		return Effect.succeed({
			tokens: resolved.tokens,
			attributeKeys: resolved.attributeKeys,
			resourceAttributeKeys: resolved.resourceAttributeKeys,
		})
	}

	let query: QuerySpec
	let sampleCountStrategy: QueryEngineSampleCountStrategy

	const traceMetric = traceSignalMetrics[rule.signalType]
	if (traceMetric) {
		const groupResolved = yield* resolveRuleGroupBy("traces")
		const filters: Record<string, unknown> = { ...baseTraceFilters, rootSpansOnly: true }
		if (groupResolved && groupResolved.attributeKeys.length > 0) {
			filters.groupByAttributeKeys = [...groupResolved.attributeKeys]
		}
		query = decodeQuerySpecSync({
			kind: "timeseries",
			source: "traces",
			metric: traceMetric,
			groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
			bucketSeconds,
			...(rule.signalType === "apdex" ? { apdexThresholdMs: rule.apdexThresholdMs ?? 500 } : {}),
			filters,
		})
		sampleCountStrategy = "trace_count"
	} else if (rule.signalType === "metric") {
		if (rule.metricName == null || rule.metricType == null || rule.metricAggregation == null) {
			return yield* Effect.fail(
				makeValidationError("metric alerts require metricName, metricType, and metricAggregation"),
			)
		}
		const groupResolved = yield* resolveRuleGroupBy("metrics")
		const filters: Record<string, unknown> = {
			metricName: rule.metricName,
			metricType: rule.metricType,
			...(rule.serviceName == null ? {} : { serviceName: rule.serviceName }),
		}
		if (groupResolved && groupResolved.attributeKeys.length > 0) {
			// Metrics group-by-attribute is single-key today; pick the first.
			filters.groupByAttributeKey = groupResolved.attributeKeys[0]
		}
		if (groupResolved && groupResolved.resourceAttributeKeys.length > 0) {
			filters.groupByResourceAttributeKey = groupResolved.resourceAttributeKeys[0]
		}
		query = decodeQuerySpecSync({
			kind: "timeseries",
			source: "metrics",
			metric: rule.metricAggregation,
			groupBy: groupResolved ? [...groupResolved.tokens] : ["none"],
			bucketSeconds,
			filters,
		})
		sampleCountStrategy = "metric_data_points"
	} else if (rule.signalType === "builder_query") {
		// Reuse the exact compiler that dashboard query-builder charts use, so
		// an alert and a chart built from the same draft evaluate identically.
		if (rule.queryBuilderDraft == null) {
			return yield* Effect.fail(makeValidationError("builder_query alerts require a queryBuilderDraft"))
		}
		const built = buildTimeseriesQuerySpec(rule.queryBuilderDraft)
		if (built.error != null || built.query == null) {
			return yield* Effect.fail(
				makeValidationError(built.error ?? "Failed to build query builder spec", [...built.warnings]),
			)
		}
		// Force the evaluation window's bucket size; the draft's stepInterval is
		// a chart-rendering concern and irrelevant to threshold evaluation.
		query = decodeQuerySpecSync({ ...built.query, bucketSeconds })
		sampleCountStrategy =
			rule.queryBuilderDraft.dataSource === "logs"
				? "log_count"
				: rule.queryBuilderDraft.dataSource === "metrics"
					? "metric_data_points"
					: "trace_count"
	} else if (rule.signalType === "raw_query") {
		const sql = rule.rawQuerySql?.trim() ?? ""
		if (sql.length === 0) {
			return yield* Effect.fail(makeValidationError("raw_query alerts require rawQuerySql"))
		}
		if (!sql.includes("$__orgFilter")) {
			return yield* Effect.fail(
				makeValidationError("raw_query SQL must reference $__orgFilter for org scoping"),
			)
		}
		return new CompiledAlertQueryPlan({
			kind: "raw_sql",
			query: null,
			rawSql: sql,
			reducer: rule.rawQueryReducer ?? "identity",
			sampleCountStrategy: null,
			noDataBehavior,
		})
	} else {
		return yield* Effect.fail(makeValidationError(`Unsupported signal type: ${rule.signalType}`))
	}

	return new CompiledAlertQueryPlan({
		kind: "spec",
		query,
		rawSql: null,
		reducer: "identity",
		sampleCountStrategy,
		noDataBehavior,
	})
})

const parseCompiledPlan = (
	row: Pick<
		AlertRuleRow,
		"querySpecJson" | "rawQuerySql" | "reducer" | "sampleCountStrategy" | "noDataBehavior"
	>,
): Effect.Effect<Schema.Schema.Type<typeof CompiledAlertQueryPlan>, AlertValidationError> => {
	if (row.rawQuerySql != null) {
		return Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
			kind: "raw_sql",
			query: null,
			rawSql: row.rawQuerySql,
			reducer: row.reducer,
			sampleCountStrategy: null,
			noDataBehavior: row.noDataBehavior,
		}).pipe(
			Effect.mapError((cause) =>
				makeValidationError("Stored compiled alert plan is invalid", [], cause),
			),
		)
	}
	return Schema.decodeUnknownEffect(QuerySpec)(row.querySpecJson).pipe(
		Effect.flatMap((query) =>
			Schema.decodeUnknownEffect(CompiledAlertQueryPlan)({
				kind: "spec",
				query,
				rawSql: null,
				reducer: row.reducer,
				sampleCountStrategy: row.sampleCountStrategy,
				noDataBehavior: row.noDataBehavior,
			}),
		),
		Effect.mapError((cause) => makeValidationError("Stored compiled alert plan is invalid", [], cause)),
	)
}

const rowToDestinationDocument = (row: AlertDestinationRow, publicConfig: DestinationPublicConfig) =>
	new AlertDestinationDocument({
		id: decodeAlertDestinationIdSync(row.id),
		name: row.name,
		type: decodeAlertDestinationTypeSync(row.type),
		enabled: row.enabled,
		summary: publicConfig.summary,
		channelLabel: publicConfig.channelLabel,
		lastTestedAt: toIso(row.lastTestedAt),
		lastTestError: row.lastTestError,
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
	})

const serviceNamesFromRow = (row: AlertRuleRow): ReadonlyArray<string> =>
	row.serviceNamesJson ? safeParseStringArray(row.serviceNamesJson) : []

const excludeServiceNamesFromRow = (row: AlertRuleRow): ReadonlyArray<string> =>
	row.excludeServiceNamesJson ? safeParseStringArray(row.excludeServiceNamesJson) : []

const tagsFromRow = (row: AlertRuleRow): ReadonlyArray<string> =>
	row.tagsJson ? safeParseStringArray(row.tagsJson) : []

/**
 * Canonical tag form: trim, lowercase, drop empties, dedupe (order preserved).
 * Lowercasing keeps `Prod` and `prod` from splitting into two groups in the UI.
 */
const normalizeTags = (tags: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
	if (!tags || tags.length === 0) return []
	const seen = new Set<string>()
	const result: string[] = []
	for (const raw of tags) {
		const tag = raw.trim().toLowerCase()
		if (tag.length === 0 || seen.has(tag)) continue
		seen.add(tag)
		result.push(tag)
	}
	return result
}

/** Most recent evaluation error for a rule, aggregated across its group states. */
interface RuleEvaluationState {
	readonly error: string | null
	readonly evaluatedAt: number | null
}

const rowToRuleDocument = (
	row: AlertRuleRow,
	destinationIds: ReadonlyArray<string>,
	evaluationState?: RuleEvaluationState,
) => {
	const serviceNames = serviceNamesFromRow(row)
	return new AlertRuleDocument({
		id: decodeAlertRuleIdSync(row.id),
		name: row.name,
		notes: row.notes ?? null,
		notificationTemplate: parseStoredNotificationTemplate(row.notificationTemplateJson),
		enabled: row.enabled,
		severity: decodeAlertSeveritySync(row.severity),
		serviceNames: [...serviceNames],
		excludeServiceNames: [...excludeServiceNamesFromRow(row)],
		tags: [...tagsFromRow(row)],
		groupBy: parseStoredGroupBy(row.groupBy),
		signalType: decodeAlertSignalTypeSync(row.signalType),
		comparator: decodeAlertComparatorSync(row.comparator),
		threshold: row.threshold,
		thresholdUpper: row.thresholdUpper,
		windowMinutes: row.windowMinutes,
		minimumSampleCount: row.minimumSampleCount,
		consecutiveBreachesRequired: row.consecutiveBreachesRequired,
		consecutiveHealthyRequired: row.consecutiveHealthyRequired,
		renotifyIntervalMinutes: row.renotifyIntervalMinutes,
		metricName: row.metricName,
		metricType: row.metricType != null ? decodeAlertMetricTypeSync(row.metricType) : null,
		metricAggregation:
			row.metricAggregation != null ? decodeAlertMetricAggregationSync(row.metricAggregation) : null,
		apdexThresholdMs: row.apdexThresholdMs,
		queryBuilderDraft: parseStoredQueryBuilderDraft(row.queryBuilderDraftJson),
		rawQuerySql: row.rawQuerySql ?? null,
		rawQueryReducer:
			row.signalType === "raw_query" ? decodeQueryEngineAlertReducerSync(row.reducer) : null,
		destinationIds: destinationIds.map((id) => decodeAlertDestinationIdSync(id)),
		noDataBehavior: decodeNoDataBehaviorSync(row.noDataBehavior),
		lastEvaluationError: evaluationState?.error ?? null,
		lastEvaluatedAt:
			evaluationState?.evaluatedAt != null
				? decodeIsoDateTimeStringSync(new Date(evaluationState.evaluatedAt).toISOString())
				: null,
		lastScheduledAt: toIso(row.lastScheduledAt),
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
		createdBy: decodeUserIdSync(row.createdBy),
		updatedBy: decodeUserIdSync(row.updatedBy),
	})
}

const rowToIncidentDocument = (row: AlertIncidentRow) =>
	new AlertIncidentDocument({
		id: decodeAlertIncidentIdSync(row.id),
		ruleId: decodeAlertRuleIdSync(row.ruleId),
		ruleName: row.ruleName,
		groupKey: row.groupKey,
		signalType: decodeAlertSignalTypeSync(row.signalType),
		severity: decodeAlertSeveritySync(row.severity),
		status: decodeAlertIncidentStatusSync(row.status),
		comparator: decodeAlertComparatorSync(row.comparator),
		threshold: row.threshold,
		thresholdUpper: row.thresholdUpper,
		firstTriggeredAt: decodeIsoDateTimeStringSync(row.firstTriggeredAt.toISOString()),
		lastTriggeredAt: decodeIsoDateTimeStringSync(row.lastTriggeredAt.toISOString()),
		resolvedAt: toIso(row.resolvedAt),
		lastObservedValue: row.lastObservedValue,
		lastSampleCount: row.lastSampleCount,
		dedupeKey: row.dedupeKey,
		lastDeliveredEventType:
			row.lastDeliveredEventType != null ? decodeAlertEventTypeSync(row.lastDeliveredEventType) : null,
		lastNotifiedAt: toIso(row.lastNotifiedAt),
		errorIssueId: row.errorIssueId != null ? decodeErrorIssueIdSync(row.errorIssueId) : null,
	})

// Formatting helpers imported from AlertDeliveryDispatch

export interface AlertsServiceShape {
	readonly listDestinations: (
		orgId: OrgId,
	) => Effect.Effect<AlertDestinationsListResponse, AlertPersistenceError>
	readonly createDestination: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertDestinationCreateRequest,
	) => Effect.Effect<
		AlertDestinationDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError
	>
	readonly updateDestination: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		destinationId: AlertDestinationDocument["id"],
		request: AlertDestinationUpdateRequest,
	) => Effect.Effect<
		AlertDestinationDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | AlertNotFoundError
	>
	readonly deleteDestination: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		destinationId: AlertDestinationDocument["id"],
	) => Effect.Effect<
		AlertDestinationDeleteResponse,
		AlertForbiddenError | AlertPersistenceError | AlertNotFoundError | AlertDestinationInUseError
	>
	readonly testDestination: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		destinationId: AlertDestinationDocument["id"],
	) => Effect.Effect<
		AlertDestinationTestResponse,
		| AlertForbiddenError
		| AlertPersistenceError
		| AlertNotFoundError
		| AlertDeliveryError
		| AlertValidationError
	>
	readonly listRules: (orgId: OrgId) => Effect.Effect<AlertRulesListResponse, AlertPersistenceError>
	readonly createRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertRuleUpsertRequest,
	) => Effect.Effect<
		AlertRuleDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | AlertNotFoundError
	>
	readonly updateRule: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
		request: AlertRuleUpsertRequest,
	) => Effect.Effect<
		AlertRuleDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | AlertNotFoundError
	>
	readonly deleteRule: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
	) => Effect.Effect<
		AlertRuleDeleteResponse,
		AlertForbiddenError | AlertPersistenceError | AlertNotFoundError
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
		| AlertNotFoundError
		| AlertDeliveryError
		| WarehouseError
	>
	readonly previewRule: (
		orgId: OrgId,
		request: AlertRulePreviewRequest,
	) => Effect.Effect<
		AlertRulePreviewResponse,
		AlertValidationError | AlertDeliveryError | AlertPersistenceError | WarehouseError
	>
	readonly listIncidents: (orgId: OrgId) => Effect.Effect<AlertIncidentsListResponse, AlertPersistenceError>
	readonly listRuleChecks: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		options: {
			readonly groupKey?: string
			readonly since?: string
			readonly until?: string
			readonly limit?: number
		},
	) => Effect.Effect<AlertChecksListResponse, AlertPersistenceError | AlertNotFoundError>
	readonly listDeliveryEvents: (
		orgId: OrgId,
	) => Effect.Effect<AlertDeliveryEventsListResponse, AlertPersistenceError>
	readonly runSchedulerTick: () => Effect.Effect<
		{
			readonly evaluatedCount: number
			readonly processedCount: number
			readonly evaluationFailureCount: number
			readonly deliveryFailureCount: number
		},
		AlertPersistenceError | AlertDeliveryError | AlertValidationError | AlertNotFoundError
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
			const queryEngine = yield* QueryEngineService
			const warehouse = yield* WarehouseQueryService
			const runtime = yield* AlertRuntime
			const hazelOAuth = yield* HazelOAuthService
			const encryptionKey = yield* parseEncryptionKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			)
			// Optional: present only inside a Worker isolate. Used to kick off the
			// AI triage Workflow for issues created from freshly opened incidents.
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
			const aiTriageWorkflowBinding = Option.match(workerEnv, {
				onNone: () => undefined,
				onSome: (e) => e[AI_TRIAGE_WORKFLOW_BINDING],
			})
			const now = runtime.now
			const makeUuid = () => runtime.makeUuid()
			const deliveryTimeoutMs = () => runtime.deliveryTimeoutMs()
			const workerId = makeUuid()

			const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
				database.execute(fn).pipe(
					Effect.tapError((error) =>
						Effect.logError("AlertsService dbExecute failed").pipe(
							Effect.annotateLogs({
								message: error.message,
								cause: describeCause(error.cause) ?? "(none)",
							}),
						),
					),
					Effect.mapError(makePersistenceError),
				)

			const requireAdmin = Effect.fn("AlertsService.requireAdmin")(function* (
				roles: ReadonlyArray<RoleName>,
			) {
				if (isAdmin(roles)) return
				return yield* Effect.fail(
					new AlertForbiddenError({
						message: "Only org admins can manage alerts",
						...(roles.length > 0 ? { roles: [...roles] } : {}),
					}),
				)
			})

			const requireDestinationRow = Effect.fn("AlertsService.requireDestinationRow")(function* (
				orgId: OrgId,
				destinationId: AlertDestinationDocument["id"],
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertDestinations)
						.where(
							and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)),
						)
						.limit(1),
				)
				if (rows[0]) return rows[0]
				return yield* Effect.fail(
					new AlertNotFoundError({
						message: "Alert destination not found",
						resourceType: "destination",
						resourceId: destinationId,
					}),
				)
			})

			const hydrateDestination = Effect.fn("AlertsService.hydrateDestination")(function* (
				row: AlertDestinationRow,
			) {
				const publicConfig = yield* parsePublicConfig(row)
				const secretJson = yield* decryptSecret(row, encryptionKey)
				const secretConfig = yield* parseSecretConfig(secretJson)
				return {
					row,
					publicConfig,
					secretConfig,
					document: rowToDestinationDocument(row, publicConfig),
				} as const
			})

			const enrichSecretForDispatch = (
				_row: AlertDestinationRow,
				secretConfig: DestinationSecretConfig,
			): Effect.Effect<EnrichedDestinationSecretConfig, AlertDeliveryError> =>
				// Hazel-OAuth webhooks embed their delivery token in the URL path, so
				// there's nothing to enrich at dispatch time.
				Effect.succeed(secretConfig)

			const requireRuleRow = Effect.fn("AlertsService.requireRuleRow")(function* (
				orgId: OrgId,
				ruleId: AlertRuleDocument["id"],
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertRules)
						.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
						.limit(1),
				)
				if (rows[0]) return rows[0]
				return yield* Effect.fail(
					new AlertNotFoundError({
						message: "Alert rule not found",
						resourceType: "rule",
						resourceId: ruleId,
					}),
				)
			})

			const parseDestinationIds = (
				value: unknown,
			): Effect.Effect<ReadonlyArray<AlertDestinationId>, AlertValidationError> =>
				Schema.decodeUnknownEffect(DestinationIdArraySchema)(value).pipe(
					Effect.mapError((cause) =>
						makeValidationError("Stored rule destinations are invalid", [], cause),
					),
				)

			const normalizeRuleRow = Effect.fn("AlertsService.normalizeRuleRow")(function* (
				row: AlertRuleRow,
			): Effect.fn.Return<NormalizedRule, AlertValidationError> {
				const serviceNames = serviceNamesFromRow(row)
				return {
					id: decodeAlertRuleIdSync(row.id),
					name: row.name,
					notificationTemplate: parseStoredNotificationTemplate(row.notificationTemplateJson),
					enabled: row.enabled,
					severity: decodeAlertSeveritySync(row.severity),
					serviceName: serviceNames.length === 1 ? serviceNames[0] : null,
					serviceNames,
					excludeServiceNames: excludeServiceNamesFromRow(row),
					tags: tagsFromRow(row),
					groupBy: parseStoredGroupBy(row.groupBy),
					signalType: decodeAlertSignalTypeSync(row.signalType),
					comparator: decodeAlertComparatorSync(row.comparator),
					threshold: row.threshold,
					thresholdUpper: row.thresholdUpper,
					windowMinutes: row.windowMinutes,
					minimumSampleCount: row.minimumSampleCount,
					consecutiveBreachesRequired: row.consecutiveBreachesRequired,
					consecutiveHealthyRequired: row.consecutiveHealthyRequired,
					renotifyIntervalMinutes: row.renotifyIntervalMinutes,
					metricName: row.metricName,
					metricType: row.metricType != null ? decodeAlertMetricTypeSync(row.metricType) : null,
					metricAggregation:
						row.metricAggregation != null
							? decodeAlertMetricAggregationSync(row.metricAggregation)
							: null,
					apdexThresholdMs: row.apdexThresholdMs,
					queryBuilderDraft: parseStoredQueryBuilderDraft(row.queryBuilderDraftJson),
					rawQuerySql: row.rawQuerySql ?? null,
					rawQueryReducer:
						row.signalType === "raw_query"
							? decodeQueryEngineAlertReducerSync(row.reducer)
							: null,
					destinationIds: yield* parseDestinationIds(row.destinationIdsJson),
					compiledPlan: yield* parseCompiledPlan(row),
					createdAt: row.createdAt.getTime(),
					updatedAt: row.updatedAt.getTime(),
				}
			})

			const normalizeRule = Effect.fn("AlertsService.normalizeRule")(function* (
				request: AlertRuleUpsertRequest,
				options?: {
					// Preview evaluates a form draft that may not have a name or
					// destinations yet — neither affects what the chart shows.
					readonly forPreview?: boolean
				},
			): Effect.fn.Return<NormalizedRule, AlertValidationError> {
				const name = request.name.trim()
				const serviceNames =
					request.serviceNames && request.serviceNames.length > 0
						? request.serviceNames.map((s) => s.trim()).filter((s) => s.length > 0)
						: []
				const serviceName = serviceNames.length === 1 ? serviceNames[0] : null
				const excludeServiceNames = request.excludeServiceNames
					? request.excludeServiceNames.map((s) => s.trim()).filter((s) => s.length > 0)
					: []
				const tags = normalizeTags(request.tags)
				const metricName = normalizeOptionalString(request.metricName)
				// Dedupe while preserving selection order — a destination listed twice still
				// notifies once, so we persist each id at most once. This is the authoritative
				// fix; the editor also dedupes on submit for UX (see buildRuleRequest).
				const destinationIds = [...new Set(request.destinationIds)]

				const details: string[] = []
				if (name.length === 0 && !options?.forPreview) details.push("name is required")
				if (destinationIds.length === 0 && !options?.forPreview) {
					details.push("at least one destination must be selected")
				}
				if (request.threshold == null || !Number.isFinite(request.threshold)) {
					details.push("threshold must be a finite number")
				}
				const isRange = request.comparator === "between" || request.comparator === "not_between"
				if (isRange) {
					if (request.thresholdUpper == null || !Number.isFinite(request.thresholdUpper)) {
						details.push("thresholdUpper is required for between / not_between comparators")
					} else if (request.threshold != null && request.thresholdUpper < request.threshold) {
						details.push("thresholdUpper must be greater than or equal to threshold")
					}
				} else if (request.thresholdUpper != null) {
					details.push("thresholdUpper is only supported for between / not_between comparators")
				}
				if (request.signalType === "metric") {
					if (!metricName) details.push("metricName is required for metric alerts")
					if (!request.metricType) details.push("metricType is required for metric alerts")
					if (!request.metricAggregation) {
						details.push("metricAggregation is required for metric alerts")
					}
				}
				if (request.signalType === "builder_query") {
					if (!request.queryBuilderDraft) {
						details.push("queryBuilderDraft is required for builder_query alerts")
					}
				}
				if (request.signalType === "raw_query") {
					const sql = request.rawQuerySql?.trim() ?? ""
					if (sql.length === 0) {
						details.push("rawQuerySql is required for raw_query alerts")
					} else if (!sql.includes("$__orgFilter")) {
						details.push("rawQuerySql must reference $__orgFilter for org scoping")
					}
				}
				const allowsMetricFields = request.signalType === "metric"
				if (!allowsMetricFields && request.metricType) {
					details.push("metricType is only supported for metric alerts")
				}
				if (!allowsMetricFields && metricName) {
					details.push("metricName is only supported for metric alerts")
				}
				if (request.signalType !== "metric" && request.metricAggregation) {
					details.push("metricAggregation is only supported for metric alerts")
				}
				const groupBy = request.groupBy ?? null
				if (groupBy != null && serviceNames.length > 0) {
					details.push("groupBy is only supported when no service is specified")
				}
				if (excludeServiceNames.length > 0 && serviceNames.length > 0) {
					details.push(
						"excludeServiceNames is only supported when no specific services are selected",
					)
				}
				if (excludeServiceNames.length > 0 && !isServiceGroupBy(groupBy)) {
					details.push('excludeServiceNames requires groupBy=["service.name"]')
				}

				if (details.length > 0) {
					return yield* Effect.fail(makeValidationError("Invalid alert rule", details))
				}

				const nowMs = yield* now
				const normalizedBase = {
					id: decodeAlertRuleIdSync(makeUuid()),
					name,
					notificationTemplate: request.notificationTemplate ?? null,
					enabled: request.enabled ?? true,
					severity: request.severity,
					serviceName,
					serviceNames,
					excludeServiceNames,
					tags,
					groupBy,
					signalType: request.signalType,
					comparator: request.comparator,
					threshold: request.threshold,
					thresholdUpper: request.thresholdUpper ?? null,
					windowMinutes: request.windowMinutes,
					minimumSampleCount: request.minimumSampleCount ?? 0,
					consecutiveBreachesRequired: request.consecutiveBreachesRequired ?? 2,
					consecutiveHealthyRequired: request.consecutiveHealthyRequired ?? 2,
					renotifyIntervalMinutes: request.renotifyIntervalMinutes ?? 30,
					metricName,
					metricType: request.metricType ?? null,
					metricAggregation: request.metricAggregation ?? null,
					apdexThresholdMs:
						request.apdexThresholdMs ?? (request.signalType === "apdex" ? 500 : null),
					queryBuilderDraft: request.queryBuilderDraft ?? null,
					rawQuerySql: normalizeOptionalString(request.rawQuerySql),
					rawQueryReducer: request.rawQueryReducer ?? null,
					destinationIds,
					createdAt: nowMs,
					updatedAt: nowMs,
				}
				const compiledPlan = yield* compileRulePlan(normalizedBase)

				return {
					...normalizedBase,
					compiledPlan,
				}
			})

			const requireDestinationIds = Effect.fn("AlertsService.requireDestinationIds")(function* (
				orgId: OrgId,
				destinationIds: ReadonlyArray<AlertDestinationId>,
			) {
				if (destinationIds.length === 0) return

				const rows = yield* dbExecute((db) =>
					db
						.select({ id: alertDestinations.id })
						.from(alertDestinations)
						.where(
							and(
								eq(alertDestinations.orgId, orgId),
								inArray(alertDestinations.id, [...destinationIds]),
							),
						),
				)

				const existingIds = new Set(rows.map((row) => row.id))
				const missing = destinationIds.filter((id) => !existingIds.has(id))
				if (missing.length > 0) {
					return yield* Effect.fail(makeValidationError("Unknown destination IDs", missing))
				}
			})

			const systemTenant = (orgId: OrgId): TenantContext => ({
				orgId,
				userId: decodeUserIdSync("system-alerting"),
				roles: [decodeRoleNameSync("root")],
				authMode: "self_hosted",
			})

			// Collapse alert-domain semantic errors (validation/execution/timeout from
			// the query engine layer) into AlertValidation/AlertDelivery, but let the
			// Tinybird tagged errors (WarehouseQueryError + WarehouseQuotaExceededError)
			// propagate so the client receives the tag + structured fields
			// (upstreamStatus, setting, pipe). formatBackendError on the frontend
			// handles them.
			const catchQueryEngineErrors = <A, R>(
				effect: Effect.Effect<
					A,
					| QueryEngineValidationError
					| QueryEngineExecutionError
					| QueryEngineTimeoutError
					| WarehouseError,
					R
				>,
			) =>
				effect.pipe(
					Effect.catchTags({
						"@maple/http/errors/QueryEngineValidationError": (e) =>
							Effect.fail(makeValidationError(e.message, e.details)),
						"@maple/http/errors/QueryEngineExecutionError": (e) =>
							Effect.fail(makeDeliveryError(e.message)),
						"@maple/http/errors/QueryEngineTimeoutError": (e) =>
							Effect.fail(makeDeliveryError(e.message ?? "Alert evaluation timed out")),
					}),
				)

			/**
			 * Evaluate the alert rule and return one outcome per group. For
			 * ungrouped rules the array always has length 1 with `groupKey = "all"`.
			 * For grouped rules every distinct value (or composite value, when
			 * multiple dimensions are picked) becomes its own entry that is
			 * processed and dedup'd independently downstream.
			 */
			const evaluateRule = Effect.fn("AlertsService.evaluateRule")(function* (
				orgId: OrgId,
				rule: NormalizedRule,
			): Effect.fn.Return<
				ReadonlyArray<{ evaluation: EvaluatedRule; groupKey: string }>,
				AlertValidationError | AlertDeliveryError | WarehouseError
			> {
				const endMs = yield* now
				const startMs = endMs - rule.windowMinutes * 60_000
				const plan = rule.compiledPlan
				let observations: ReadonlyArray<GroupedAlertObservation>
				if (plan.kind === "raw_sql") {
					observations = yield* queryEngine
						.evaluateRawSql(systemTenant(orgId), {
							startTime: toTinybirdDateTime(startMs),
							endTime: toTinybirdDateTime(endMs),
							sql: plan.rawSql ?? "",
							reducer: plan.reducer,
							windowMinutes: rule.windowMinutes,
						})
						.pipe(catchQueryEngineErrors)
				} else {
					if (plan.query == null || plan.sampleCountStrategy == null) {
						return yield* Effect.fail(
							makeValidationError("Compiled alert plan is missing its query spec"),
						)
					}
					observations = yield* queryEngine
						.evaluate(systemTenant(orgId), {
							startTime: toTinybirdDateTime(startMs),
							endTime: toTinybirdDateTime(endMs),
							query: plan.query,
							reducer: plan.reducer,
							sampleCountStrategy: plan.sampleCountStrategy,
						})
						.pipe(catchQueryEngineErrors)
				}

				return observations.map((obs) => ({
					evaluation: applyEvaluationLogic(rule, obs),
					groupKey: obs.groupKey,
				}))
			})

			const applyEvaluationLogic = (
				rule: NormalizedRule,
				obs: Pick<GroupedAlertObservation, "value" | "sampleCount" | "hasData">,
				reasonOverride?: string,
			): EvaluatedRule => {
				const noDataBehavior = rule.compiledPlan.noDataBehavior
				const sampleCount = obs.sampleCount
				const value = obs.hasData ? obs.value : noDataBehavior === "zero" ? 0 : null

				if (!obs.hasData && noDataBehavior === "skip") {
					return {
						status: "skipped",
						value: null,
						sampleCount,
						threshold: rule.threshold,
						thresholdUpper: rule.thresholdUpper,
						comparator: rule.comparator,
						reason:
							rule.signalType === "metric"
								? "No metric data in the selected window"
								: "No data in the selected window",
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

			const markDestinationTest = Effect.fn("AlertsService.markDestinationTest")(function* (
				orgId: OrgId,
				destinationId: AlertDestinationId,
				errorMessage: string | null,
			) {
				const timestamp = yield* now
				yield* dbExecute((db) =>
					db
						.update(alertDestinations)
						.set({
							lastTestedAt: new Date(timestamp),
							lastTestError: errorMessage,
							updatedAt: new Date(timestamp),
						})
						.where(
							and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)),
						),
				)
			})

			const composeLinkUrl = (serviceLinkName: string | null) =>
				serviceLinkName
					? `${env.MAPLE_APP_BASE_URL}/services/${encodeURIComponent(serviceLinkName)}`
					: `${env.MAPLE_APP_BASE_URL}/alerts`

			const resolveNotificationLinkUrl = (
				rule: Pick<NormalizedRule, "serviceNames" | "groupBy">,
				groupKey: string | null,
			) => composeLinkUrl(resolveServiceLinkName(rule, groupKey))

			const composeChatUrl = (context: DispatchContext): string =>
				buildAlertChatUrl(env.MAPLE_APP_BASE_URL, context)

			const dispatchDelivery = (
				context: DispatchContext,
				payloadJson: string,
			): Effect.Effect<DispatchResult, AlertDeliveryError> =>
				dispatchDeliveryImpl(
					context,
					payloadJson,
					runtime.fetch,
					deliveryTimeoutMs(),
					context.linkUrl,
					composeChatUrl(context),
				)

			const buildPayload = (context: DeliveryPayloadContext) => ({
				eventType: context.eventType,
				incidentId: context.incidentId,
				incidentStatus: context.incidentStatus,
				dedupeKey: context.dedupeKey,
				rule: {
					id: context.ruleId,
					name: context.ruleName,
					signalType: context.signalType,
					severity: context.severity,
					groupKey: context.groupKey,
					comparator: context.comparator,
					threshold: context.threshold,
					thresholdUpper: context.thresholdUpper,
					windowMinutes: context.windowMinutes,
				},
				observed: {
					value: context.value,
					sampleCount: context.sampleCount,
				},
				template: context.template ?? null,
				linkUrl: context.linkUrl,
				chatUrl: buildAlertChatUrl(env.MAPLE_APP_BASE_URL, context),
				sentAt: new Date(context.sentAtMs).toISOString(),
			})

			const toDeliveryAttemptFailure = (
				error: AlertValidationError | AlertDeliveryError | AlertNotFoundError | AlertPersistenceError,
			): DeliveryAttemptFailure =>
				Match.value(error).pipe(
					Match.discriminatorsExhaustive("_tag")({
						"@maple/http/errors/AlertValidationError": (e) => ({
							message: e.message,
							kind: "payload" as const,
							retryable: false,
						}),
						"@maple/http/errors/AlertDeliveryError": (e) => ({
							message: e.message,
							kind: e.message.includes("timed out")
								? ("timeout" as const)
								: ("transport" as const),
							retryable: true,
						}),
						"@maple/http/errors/AlertNotFoundError": (e) => ({
							message: e.message,
							kind: "destination" as const,
							retryable: false,
						}),
						"@maple/http/errors/AlertPersistenceError": (e) => ({
							message: e.message,
							kind: "unknown" as const,
							retryable: false,
						}),
					}),
				)

			const sendImmediateNotification = Effect.fn("AlertsService.sendImmediateNotification")(function* (
				destinationRow: AlertDestinationRow,
				context: Omit<DispatchContext, "destination" | "publicConfig" | "secretConfig">,
			) {
				const hydrated = yield* hydrateDestination(destinationRow)
				const enrichedSecret = yield* enrichSecretForDispatch(hydrated.row, hydrated.secretConfig)
				const fullContext: DispatchContext = {
					destination: hydrated.row,
					publicConfig: hydrated.publicConfig,
					secretConfig: enrichedSecret,
					...context,
				}
				const payload = buildPayload(fullContext)
				const payloadJson = JSON.stringify(payload)
				return yield* dispatchDelivery(fullContext, payloadJson)
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

			const listDestinations = Effect.fn("AlertsService.listDestinations")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertDestinations)
						.where(eq(alertDestinations.orgId, orgId))
						.orderBy(desc(alertDestinations.updatedAt)),
				)

				const destinations = rows.map((row) =>
					rowToDestinationDocument(row, safeParsePublicConfig(row)),
				)

				return new AlertDestinationsListResponse({ destinations })
			})

			// Reject a PagerDuty routing key that can't possibly work before we persist
			// it, so a wrong key surfaces at connect time instead of at first page.
			// Format check is instant; the live check enqueues a no-op resolve event and
			// only rejects on a definitive "invalid key" — it fails open on outages.
			const validatePagerDutyKey = Effect.fn("AlertsService.validatePagerDutyKey")(function* (
				integrationKey: string,
			) {
				if (!PAGERDUTY_ROUTING_KEY_PATTERN.test(integrationKey)) {
					return yield* Effect.fail(
						makeValidationError(
							"PagerDuty integration key must be a 32-character Events API v2 routing key — a REST API token won't work.",
						),
					)
				}
				const result = yield* verifyPagerDutyRoutingKey(
					integrationKey,
					runtime.fetch,
					deliveryTimeoutMs(),
					`maple-keycheck-${makeUuid()}`,
				)
				if (result.status === "invalid") {
					return yield* Effect.fail(
						makeValidationError(`PagerDuty rejected this routing key: ${result.reason}`),
					)
				}
			})

			const createDestination = Effect.fn("AlertsService.createDestination")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: AlertDestinationCreateRequest,
			) {
				yield* requireAdmin(roles)
				// Reject URLs pointing at internal/loopback/metadata networks before we
				// persist them. The dispatcher will later POST to whatever we store.
				if (request.type === "slack") {
					yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
				} else if (request.type === "webhook") {
					yield* validateDestinationUrl(request.url, "url")
				} else if (request.type === "hazel") {
					yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
				} else if (request.type === "discord") {
					yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
				}
				const destinationId = decodeAlertDestinationIdSync(makeUuid())
				const publicConfig = buildPublicConfig(request)
				const secretConfig: DestinationSecretConfig =
					request.type === "hazel-oauth"
						? yield* hazelOAuth
								.createChannelWebhook(orgId, {
									channelId: request.hazelChannelId.trim(),
									name: request.name.trim(),
								})
								.pipe(
									Effect.map((webhook) => ({
										type: "hazel-oauth" as const,
										hazelOrganizationId: request.hazelOrganizationId.trim(),
										hazelOrganizationName: request.hazelOrganizationName.trim(),
										hazelChannelId: request.hazelChannelId.trim(),
										hazelChannelName: request.hazelChannelName.trim(),
										webhookId: webhook.id,
										webhookUrl: webhook.webhookUrl,
										webhookToken: webhook.token,
									})),
									Effect.mapError((error) =>
										makeValidationError(
											`Could not provision Hazel channel webhook: ${error.message}`,
										),
									),
								)
						: buildSecretConfig(request)
				if (secretConfig.type === "pagerduty") {
					yield* validatePagerDutyKey(secretConfig.integrationKey)
				}
				const encryptedSecret = yield* encryptSecret(JSON.stringify(secretConfig), encryptionKey)
				const timestamp = yield* now

				const row = {
					id: destinationId,
					orgId,
					name: request.name.trim(),
					type: request.type,
					enabled: request.enabled !== false,
					configJson: publicConfig,
					secretCiphertext: encryptedSecret.ciphertext,
					secretIv: encryptedSecret.iv,
					secretTag: encryptedSecret.tag,
					lastTestedAt: null,
					lastTestError: null,
					createdAt: new Date(timestamp),
					updatedAt: new Date(timestamp),
					createdBy: userId,
					updatedBy: userId,
				}

				yield* dbExecute((db) => db.insert(alertDestinations).values(row))

				return rowToDestinationDocument(row, publicConfig)
			})

			const updateDestination = Effect.fn("AlertsService.updateDestination")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				destinationId: AlertDestinationDocument["id"],
				request: AlertDestinationUpdateRequest,
			) {
				yield* requireAdmin(roles)
				const existing = yield* requireDestinationRow(orgId, destinationId)
				if (existing.type !== request.type) {
					return yield* Effect.fail(makeValidationError("Destination type cannot be changed"))
				}

				const hydrated = yield* hydrateDestination(existing)

				// Validate any URL the request supplies before we persist it. Each
				// branch only validates when the field is non-empty so the existing
				// (already-validated) stored URL can stay unchanged on partial updates.
				if (
					request.type === "slack" &&
					request.webhookUrl != null &&
					request.webhookUrl.trim().length > 0
				) {
					yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
				} else if (
					request.type === "webhook" &&
					request.url != null &&
					request.url.trim().length > 0
				) {
					yield* validateDestinationUrl(request.url, "url")
				} else if (
					request.type === "hazel" &&
					request.webhookUrl != null &&
					request.webhookUrl.trim().length > 0
				) {
					yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
				} else if (
					request.type === "discord" &&
					request.webhookUrl != null &&
					request.webhookUrl.trim().length > 0
				) {
					yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
				}

				const { nextPublicConfig, nextSecretConfig } = yield* Match.value(request).pipe(
					Match.discriminatorsExhaustive("type")({
						slack: (r) =>
							Effect.succeed({
								nextPublicConfig: {
									summary:
										normalizeOptionalString(r.channelLabel) ??
										hydrated.publicConfig.summary,
									channelLabel:
										normalizeOptionalString(r.channelLabel) ??
										hydrated.publicConfig.channelLabel,
								} satisfies DestinationPublicConfig,
								nextSecretConfig: {
									type: "slack" as const,
									webhookUrl:
										normalizeOptionalString(r.webhookUrl) ??
										(hydrated.secretConfig.type === "slack"
											? hydrated.secretConfig.webhookUrl
											: ""),
								} satisfies DestinationSecretConfig,
							}),
						pagerduty: (r) =>
							Effect.succeed({
								nextPublicConfig: hydrated.publicConfig,
								nextSecretConfig: {
									type: "pagerduty" as const,
									integrationKey:
										normalizeOptionalString(r.integrationKey) ??
										(hydrated.secretConfig.type === "pagerduty"
											? hydrated.secretConfig.integrationKey
											: ""),
								} satisfies DestinationSecretConfig,
							}),
						webhook: (r) =>
							Effect.succeed({
								nextPublicConfig: {
									summary:
										r.url != null && r.url.trim().length > 0
											? summarizeWebhookUrl(r.url)
											: hydrated.publicConfig.summary,
									channelLabel: null,
								} satisfies DestinationPublicConfig,
								nextSecretConfig: {
									type: "webhook" as const,
									url:
										normalizeOptionalString(r.url) ??
										(hydrated.secretConfig.type === "webhook"
											? hydrated.secretConfig.url
											: ""),
									signingSecret:
										r.signingSecret === undefined
											? hydrated.secretConfig.type === "webhook"
												? hydrated.secretConfig.signingSecret
												: null
											: normalizeOptionalString(r.signingSecret),
								} satisfies DestinationSecretConfig,
							}),
						hazel: (r) =>
							Effect.succeed({
								nextPublicConfig: {
									summary:
										r.webhookUrl != null && r.webhookUrl.trim().length > 0
											? summarizeWebhookUrl(r.webhookUrl)
											: hydrated.publicConfig.summary,
									channelLabel: null,
								} satisfies DestinationPublicConfig,
								nextSecretConfig: {
									type: "hazel" as const,
									webhookUrl:
										normalizeOptionalString(r.webhookUrl) ??
										(hydrated.secretConfig.type === "hazel"
											? hydrated.secretConfig.webhookUrl
											: ""),
									signingSecret:
										r.signingSecret === undefined
											? hydrated.secretConfig.type === "hazel"
												? hydrated.secretConfig.signingSecret
												: null
											: normalizeOptionalString(r.signingSecret),
								} satisfies DestinationSecretConfig,
							}),
						"hazel-oauth": (r) =>
							Effect.gen(function* () {
								const previousSecret =
									hydrated.secretConfig.type === "hazel-oauth"
										? hydrated.secretConfig
										: null
								const nextOrganizationId =
									normalizeOptionalString(r.hazelOrganizationId) ??
									previousSecret?.hazelOrganizationId ??
									""
								const nextOrganizationName =
									normalizeOptionalString(r.hazelOrganizationName) ??
									previousSecret?.hazelOrganizationName ??
									""
								const requestLogoUrl = r.hazelOrganizationLogoUrl
								const nextOrganizationLogoUrl =
									requestLogoUrl === undefined
										? (hydrated.publicConfig.hazelOrganizationLogoUrl ?? null)
										: requestLogoUrl
								const nextChannelId =
									normalizeOptionalString(r.hazelChannelId) ??
									previousSecret?.hazelChannelId ??
									""
								const nextChannelName =
									normalizeOptionalString(r.hazelChannelName) ??
									previousSecret?.hazelChannelName ??
									""
								const nextName = normalizeOptionalString(r.name) ?? existing.name
								const channelChanged =
									previousSecret == null || previousSecret.hazelChannelId !== nextChannelId

								// TODO: when Hazel exposes DELETE /api/v1/channel-webhooks/:id,
								// revoke the old webhook here on channel change.
								const provisioned = channelChanged
									? yield* hazelOAuth
											.createChannelWebhook(orgId, {
												channelId: nextChannelId,
												name: nextName,
											})
											.pipe(
												Effect.mapError((error) =>
													makeValidationError(
														`Could not provision Hazel channel webhook: ${error.message}`,
													),
												),
											)
									: null

								const webhookId = provisioned?.id ?? previousSecret!.webhookId
								const webhookUrl = provisioned?.webhookUrl ?? previousSecret!.webhookUrl
								const webhookToken = provisioned?.token ?? previousSecret!.webhookToken

								return {
									nextPublicConfig: {
										summary: `${nextOrganizationName} · #${nextChannelName}`,
										channelLabel: `#${nextChannelName}`,
										hazelOrganizationId: nextOrganizationId,
										hazelOrganizationName: nextOrganizationName,
										hazelOrganizationLogoUrl: nextOrganizationLogoUrl,
										hazelChannelId: nextChannelId,
										hazelChannelName: nextChannelName,
									} satisfies DestinationPublicConfig,
									nextSecretConfig: {
										type: "hazel-oauth" as const,
										hazelOrganizationId: nextOrganizationId,
										hazelOrganizationName: nextOrganizationName,
										hazelChannelId: nextChannelId,
										hazelChannelName: nextChannelName,
										webhookId,
										webhookUrl,
										webhookToken,
									} satisfies DestinationSecretConfig,
								}
							}),
						discord: (r) =>
							Effect.succeed({
								nextPublicConfig: {
									summary:
										r.webhookUrl != null && r.webhookUrl.trim().length > 0
											? summarizeWebhookUrl(r.webhookUrl)
											: hydrated.publicConfig.summary,
									channelLabel: null,
								} satisfies DestinationPublicConfig,
								nextSecretConfig: {
									type: "discord" as const,
									webhookUrl:
										normalizeOptionalString(r.webhookUrl) ??
										(hydrated.secretConfig.type === "discord"
											? hydrated.secretConfig.webhookUrl
											: ""),
								} satisfies DestinationSecretConfig,
							}),
					}),
				)

				// Validate only a newly-supplied key; a blank key keeps the stored one.
				if (
					request.type === "pagerduty" &&
					normalizeOptionalString(request.integrationKey) != null &&
					nextSecretConfig.type === "pagerduty"
				) {
					yield* validatePagerDutyKey(nextSecretConfig.integrationKey)
				}
				const encryptedSecret = yield* encryptSecret(JSON.stringify(nextSecretConfig), encryptionKey)
				const timestamp = yield* now
				const nextName = normalizeOptionalString(request.name) ?? existing.name
				const nextEnabled = request.enabled === undefined ? existing.enabled : request.enabled

				yield* dbExecute((db) =>
					db
						.update(alertDestinations)
						.set({
							name: nextName,
							enabled: nextEnabled,
							configJson: nextPublicConfig,
							secretCiphertext: encryptedSecret.ciphertext,
							secretIv: encryptedSecret.iv,
							secretTag: encryptedSecret.tag,
							updatedAt: new Date(timestamp),
							updatedBy: userId,
						})
						.where(
							and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)),
						),
				)

				return rowToDestinationDocument(
					{
						...existing,
						name: nextName,
						enabled: nextEnabled,
						configJson: nextPublicConfig,
						secretCiphertext: encryptedSecret.ciphertext,
						secretIv: encryptedSecret.iv,
						secretTag: encryptedSecret.tag,
						updatedAt: new Date(timestamp),
						updatedBy: userId,
					},
					nextPublicConfig,
				)
			})

			const deleteDestination = Effect.fn("AlertsService.deleteDestination")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
				destinationId: AlertDestinationDocument["id"],
			) {
				yield* requireAdmin(roles)
				yield* requireDestinationRow(orgId, destinationId)
				const dependentRules = yield* dbExecute((db) =>
					db
						.select({
							id: alertRules.id,
							name: alertRules.name,
							destinationIdsJson: alertRules.destinationIdsJson,
						})
						.from(alertRules)
						.where(eq(alertRules.orgId, orgId)),
				).pipe(
					Effect.map((rows) =>
						rows.filter((row) =>
							safeParseStringArray(row.destinationIdsJson).includes(destinationId),
						),
					),
				)

				if (dependentRules.length > 0) {
					const ruleIds = dependentRules.map((row) => decodeAlertRuleIdSync(row.id))
					const ruleNames = dependentRules.map((row) => row.name)
					return yield* Effect.fail(
						new AlertDestinationInUseError({
							message: `Destination is still used by alert rules: ${ruleNames.join(", ")}`,
							destinationId,
							ruleIds,
							ruleNames,
						}),
					)
				}

				yield* dbExecute((db) =>
					db
						.delete(alertDestinations)
						.where(
							and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)),
						),
				)
				return new AlertDestinationDeleteResponse({ id: destinationId })
			})

			const testDestination = Effect.fn("AlertsService.testDestination")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				destinationId: AlertDestinationDocument["id"],
			) {
				yield* requireAdmin(roles)
				const row = yield* requireDestinationRow(orgId, destinationId)
				yield* sendImmediateNotification(row, {
					deliveryKey: `${orgId}:${destinationId}:test`,
					ruleId: decodeAlertRuleIdSync(makeUuid()),
					ruleName: "Test alert",
					groupKey: null,
					signalType: "throughput",
					severity: "warning",
					comparator: "lt",
					threshold: 1,
					thresholdUpper: null,
					windowMinutes: 5,
					eventType: "test",
					incidentId: null,
					incidentStatus: "resolved",
					dedupeKey: `${orgId}:${destinationId}:test`,
					value: 0,
					sampleCount: 0,
					linkUrl: composeLinkUrl(null),
					sentAtMs: yield* now,
				}).pipe(
					Effect.tapError((error) => {
						const message =
							error instanceof AlertDeliveryError
								? error.message
								: error instanceof Error
									? error.message
									: "Destination test failed"
						return markDestinationTest(orgId, destinationId, message)
					}),
					Effect.mapError((error) =>
						error instanceof AlertDeliveryError
							? error
							: makeDeliveryError(
									error instanceof Error ? error.message : "Destination test failed",
									decodeAlertDestinationTypeSync(row.type),
								),
					),
				)

				yield* markDestinationTest(orgId, destinationId, null)
				return new AlertDestinationTestResponse({
					success: true,
					message: "Test notification sent",
				})
			})

			const upsertRuleRow = Effect.fn("AlertsService.upsertRuleRow")(function* (
				orgId: OrgId,
				userId: UserId,
				existingId: AlertRuleId | null,
				request: AlertRuleUpsertRequest,
			) {
				const normalized = yield* normalizeRule(request)
				yield* requireDestinationIds(orgId, normalized.destinationIds)
				const ruleId = existingId ?? normalized.id
				const timestamp = yield* now

				const ruleFields = {
					name: normalized.name,
					notes: normalizeOptionalString(request.notes),
					notificationTemplateJson: normalized.notificationTemplate ?? null,
					enabled: normalized.enabled,
					severity: normalized.severity,
					serviceNamesJson: normalized.serviceNames.length > 0 ? normalized.serviceNames : null,
					excludeServiceNamesJson:
						normalized.excludeServiceNames.length > 0 ? normalized.excludeServiceNames : null,
					tagsJson: normalized.tags.length > 0 ? normalized.tags : null,
					groupBy: normalized.groupBy != null ? JSON.stringify(normalized.groupBy) : null,
					signalType: normalized.signalType,
					comparator: normalized.comparator,
					threshold: normalized.threshold,
					thresholdUpper: normalized.thresholdUpper,
					windowMinutes: normalized.windowMinutes,
					minimumSampleCount: normalized.minimumSampleCount,
					consecutiveBreachesRequired: normalized.consecutiveBreachesRequired,
					consecutiveHealthyRequired: normalized.consecutiveHealthyRequired,
					renotifyIntervalMinutes: normalized.renotifyIntervalMinutes,
					metricName: normalized.metricName,
					metricType: normalized.metricType,
					metricAggregation: normalized.metricAggregation,
					apdexThresholdMs: normalized.apdexThresholdMs,
					queryBuilderDraftJson: normalized.queryBuilderDraft ?? null,
					rawQuerySql: normalized.rawQuerySql,
					destinationIdsJson: normalized.destinationIds,
					querySpecJson: normalized.compiledPlan.query ?? null,
					reducer: normalized.compiledPlan.reducer,
					sampleCountStrategy: normalized.compiledPlan.sampleCountStrategy,
					noDataBehavior: normalized.compiledPlan.noDataBehavior,
					updatedAt: new Date(timestamp),
					updatedBy: userId,
				} as const

				const writeRows =
					existingId == null
						? yield* dbExecute((db) =>
								db
									.insert(alertRules)
									.values({
										id: ruleId,
										orgId,
										...ruleFields,
										createdAt: new Date(timestamp),
										createdBy: userId,
									})
									.returning(txidColumn),
							)
						: yield* dbExecute((db) =>
								db
									.update(alertRules)
									.set(ruleFields)
									.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, existingId)))
									.returning(txidColumn),
							)
				const txid = readTxid(writeRows)

				const row = yield* requireRuleRow(orgId, ruleId)
				const destinationIds = safeParseStringArray(row.destinationIdsJson)
				const document = rowToRuleDocument(row, destinationIds)
				return txid === undefined ? document : new AlertRuleDocument({ ...document, txid })
			})

			const listRules = Effect.fn("AlertsService.listRules")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertRules)
						.where(eq(alertRules.orgId, orgId))
						.orderBy(desc(alertRules.updatedAt)),
				)

				// Surface the most recent evaluation error per rule. `lastError` is
				// cleared to null on a healthy evaluation, so a non-null value means
				// that group is currently failing; pick the freshest one.
				const stateRows = yield* dbExecute((db) =>
					db
						.select({
							ruleId: alertRuleStates.ruleId,
							lastError: alertRuleStates.lastError,
							lastEvaluatedAt: alertRuleStates.lastEvaluatedAt,
						})
						.from(alertRuleStates)
						.where(eq(alertRuleStates.orgId, orgId)),
				)
				const errorByRule = new Map<string, RuleEvaluationState>()
				for (const state of stateRows) {
					if (state.lastError == null) continue
					const existing = errorByRule.get(state.ruleId)
					if (
						existing == null ||
						(dateToMs(state.lastEvaluatedAt) ?? 0) > (existing.evaluatedAt ?? 0)
					) {
						errorByRule.set(state.ruleId, {
							error: state.lastError,
							evaluatedAt: dateToMs(state.lastEvaluatedAt),
						})
					}
				}

				const rules = rows.map((row) =>
					rowToRuleDocument(
						row,
						safeParseStringArray(row.destinationIdsJson),
						errorByRule.get(row.id),
					),
				)

				return new AlertRulesListResponse({ rules })
			})

			const createRule = Effect.fn("AlertsService.createRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: AlertRuleUpsertRequest,
			) {
				yield* requireAdmin(roles)
				return yield* upsertRuleRow(orgId, userId, null, request)
			})

			const updateRule = Effect.fn("AlertsService.updateRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				ruleId: AlertRuleDocument["id"],
				request: AlertRuleUpsertRequest,
			) {
				yield* requireAdmin(roles)
				const oldRow = yield* requireRuleRow(orgId, ruleId)
				const result = yield* upsertRuleRow(orgId, userId, ruleId, request)

				// Resolve stale incidents caused by the configuration change
				const oldNormalized = yield* normalizeRuleRow(oldRow)
				const newNormalized = yield* normalizeRule(request)

				if (oldNormalized.enabled && !newNormalized.enabled) {
					// Rule was disabled — resolve all open incidents
					yield* resolveStaleIncidents(orgId, ruleId, newNormalized, { resolveAll: true })
				} else if (ruleStructureChanged(oldNormalized, newNormalized)) {
					// Evaluation mode changed — resolve all and let scheduler re-evaluate fresh
					yield* resolveStaleIncidents(orgId, ruleId, newNormalized, { resolveAll: true })
				} else {
					// Check for services that fell out of scope
					const staleGroupKeys = computeStaleGroupKeys(oldNormalized, newNormalized)
					if (HashSet.size(staleGroupKeys) > 0) {
						yield* resolveStaleIncidents(orgId, ruleId, newNormalized, { staleGroupKeys })
					}
				}

				return result
			})

			const deleteRule = Effect.fn("AlertsService.deleteRule")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
				ruleId: AlertRuleDocument["id"],
			) {
				yield* requireAdmin(roles)
				yield* requireRuleRow(orgId, ruleId)
				// All deletes run in one transaction, so a single txid (captured on the
				// alert_rules delete — the only synced table here) covers the whole
				// change for the Electric alert_rules collection.
				const deleted = yield* dbExecute((db) =>
					db.transaction(async (tx) => {
						await tx
							.delete(alertDeliveryEvents)
							.where(
								and(
									eq(alertDeliveryEvents.orgId, orgId),
									eq(alertDeliveryEvents.ruleId, ruleId),
								),
							)
						await tx
							.delete(alertIncidents)
							.where(and(eq(alertIncidents.orgId, orgId), eq(alertIncidents.ruleId, ruleId)))
						await tx
							.delete(alertRuleStates)
							.where(and(eq(alertRuleStates.orgId, orgId), eq(alertRuleStates.ruleId, ruleId)))
						return tx
							.delete(alertRules)
							.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
							.returning(txidColumn)
					}),
				)
				const txid = readTxid(deleted)
				return new AlertRuleDeleteResponse({
					id: ruleId,
					...(txid !== undefined && { txid }),
				})
			})

			const testRule = Effect.fn("AlertsService.testRule")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: AlertRuleUpsertRequest,
				sendNotification = false,
			) {
				yield* requireAdmin(roles)
				const normalized = yield* normalizeRule(request)
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
					const excludeSet = new Set(normalized.excludeServiceNames)
					const results = isGroupedPlan(normalized.compiledPlan)
						? allResults.filter((r) => !excludeSet.has(r.groupKey))
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
						{ concurrency: "unbounded" },
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
				request: AlertRulePreviewRequest,
			): Effect.fn.Return<
				AlertRulePreviewResponse,
				AlertValidationError | AlertDeliveryError | AlertPersistenceError | WarehouseError
			> {
				const normalized = yield* normalizeRule(request.rule, { forPreview: true })
				const plan = normalized.compiledPlan

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
				const maxBuckets = plan.kind === "raw_sql" ? MAX_RAW_PREVIEW_WINDOWS : MAX_PREVIEW_BUCKETS
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

				if (plan.kind === "spec") {
					if (plan.query == null || plan.sampleCountStrategy == null) {
						return yield* Effect.fail(
							makeValidationError("Compiled alert plan is missing its query spec"),
						)
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
									if (perServicePlan.query == null || perServicePlan.sampleCountStrategy == null) {
										return
									}
									const observations = yield* queryEngine
										.evaluateSeries(systemTenant(orgId), {
											startTime: toTinybirdDateTime(startMs),
											endTime: toTinybirdDateTime(endMs),
											query: perServicePlan.query,
											reducer: perServicePlan.reducer,
											sampleCountStrategy: perServicePlan.sampleCountStrategy,
										})
										.pipe(catchQueryEngineErrors)
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
						const observations = yield* queryEngine
							.evaluateSeries(systemTenant(orgId), {
								startTime: toTinybirdDateTime(startMs),
								endTime: toTinybirdDateTime(endMs),
								query: plan.query,
								reducer: plan.reducer,
								sampleCountStrategy: plan.sampleCountStrategy,
							})
							.pipe(catchQueryEngineErrors)
						const excludeSet = new Set(normalized.excludeServiceNames)
						for (const obs of observations) {
							if (excludeSet.has(obs.groupKey)) continue
							record(obs.groupKey, Date.parse(obs.bucket), {
								value: obs.value,
								sampleCount: obs.sampleCount,
								hasData: obs.sampleCount > 0,
							})
						}
					}
				} else {
					// Raw SQL: the reducer runs INSIDE one evaluation window, so replay
					// the evaluator over each historical window. Bounded by
					// MAX_RAW_PREVIEW_WINDOWS via the range clamp above.
					yield* Effect.forEach(
						bucketStarts,
						(bucketMs) =>
							queryEngine
								.evaluateRawSql(systemTenant(orgId), {
									startTime: toTinybirdDateTime(bucketMs),
									endTime: toTinybirdDateTime(bucketMs + windowMs),
									sql: plan.rawSql ?? "",
									reducer: plan.reducer,
									windowMinutes: normalized.windowMinutes,
								})
								.pipe(
									catchQueryEngineErrors,
									Effect.map((groups) => {
										for (const group of groups) {
											record(group.groupKey, bucketMs, {
												value: group.value,
												sampleCount: group.sampleCount,
												hasData: group.hasData,
											})
										}
									}),
								),
						{ concurrency: 4 },
					)
				}

				// Ungrouped rules always observe *something* per tick ("all"), so chart
				// a series even when the whole range is empty.
				if (
					obsByGroup.size === 0 &&
					!isGroupedPlan(normalized.compiledPlan) &&
					normalized.serviceNames.length <= 1
				) {
					obsByGroup.set("all", new Map())
				}

				const NO_DATA: PreviewObs = { value: null, sampleCount: 0, hasData: false }
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
					for (const bucketMs of bucketStarts) {
						const obs = buckets.get(bucketMs) ?? NO_DATA
						const evaluation = applyEvaluationLogic(normalized, obs)
						points.push(
							new AlertRulePreviewPoint({
								bucket: iso(bucketMs),
								value: evaluation.value,
								sampleCount: obs.sampleCount,
								status: evaluation.status,
							}),
						)
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
							new AlertRulePreviewFiringSpan({ groupKey, start: iso(openStart), end: iso(endMs) }),
						)
					}
					series.push(new AlertRulePreviewSeries({ groupKey, points }))
				}

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

			const listIncidents = Effect.fn("AlertsService.listIncidents")(function* (orgId: OrgId) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertIncidents)
						.where(eq(alertIncidents.orgId, orgId))
						.orderBy(desc(alertIncidents.status), desc(alertIncidents.lastTriggeredAt))
						.limit(100),
				)
				return new AlertIncidentsListResponse({
					incidents: rows.map(rowToIncidentDocument),
				})
			})

			const toTinybirdSqlDateTime64 = (iso: string) => {
				const d = new Date(iso)
				if (Number.isNaN(d.getTime())) return null
				const pad = (n: number, w = 2) => n.toString().padStart(w, "0")
				return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
			}

			const listRuleChecks = Effect.fn("AlertsService.listRuleChecks")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				options: {
					readonly groupKey?: string
					readonly since?: string
					readonly until?: string
					readonly limit?: number
				},
			) {
				// Verify the rule exists and belongs to this org before querying Tinybird.
				const ruleRow = yield* dbExecute((db) =>
					db
						.select({ id: alertRules.id })
						.from(alertRules)
						.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
						.limit(1),
				)
				if (ruleRow.length === 0) {
					return yield* new AlertNotFoundError({
						message: "Alert rule not found",
						resourceType: "alert_rule",
						resourceId: ruleId,
					})
				}

				const clamp = (n: number | undefined, min: number, max: number, fallback: number) => {
					if (n == null || Number.isNaN(n)) return fallback
					return Math.min(max, Math.max(min, Math.trunc(n)))
				}
				const limit = clamp(options.limit, 1, 2000, 500)

				const since = options.since != null ? toTinybirdSqlDateTime64(options.since) : null
				const until = options.until != null ? toTinybirdSqlDateTime64(options.until) : null
				const hasGroupKey = options.groupKey != null && options.groupKey !== ""

				const compiled = CH.compile(
					CH.listRuleChecksQuery({
						limit,
						groupKey: hasGroupKey ? options.groupKey : undefined,
						since: since ?? undefined,
						until: until ?? undefined,
					}),
					{
						orgId,
						ruleId,
						...(hasGroupKey ? { groupKey: options.groupKey } : {}),
						...(since != null ? { since } : {}),
						...(until != null ? { until } : {}),
					},
				)

				const tenant = systemTenant(orgId)
				const rows = yield* warehouse
					// alert_checks is written via `ingest` (Tinybird-pinned) with no
					// per-org MV, so read it from the same managed Tinybird — otherwise a
					// BYO-ClickHouse org reads an empty table from its own ClickHouse.
					.compiledQuery(tenant, compiled, {
						profile: "list",
						context: "listAlertChecks",
						pinToIngestConfig: true,
					})
					.pipe(
						Effect.mapError(
							(error) =>
								new AlertPersistenceError({
									message: `Failed to list alert checks: ${error.message}`,
								}),
						),
					)

				const checks = yield* Effect.try({
					try: () =>
						rows.map((r) => {
							const rawTransition =
								r.incidentTransition == null || r.incidentTransition === ""
									? "none"
									: String(r.incidentTransition)
							return new AlertCheckDocument({
								timestamp: decodeIsoDateTimeStringSync(String(r.timestamp)),
								groupKey: String(r.groupKey ?? ""),
								status: decodeAlertCheckStatusSync(String(r.status)),
								signalType: decodeAlertSignalTypeSync(String(r.signalType)),
								comparator: decodeAlertComparatorSync(String(r.comparator)),
								threshold: Number(r.threshold),
								// thresholdUpper not yet recorded in the Tinybird alert_checks
								// datasource — schema column will be backfilled with the
								// datasource update; for now always null in the audit log.
								thresholdUpper: null,
								observedValue: r.observedValue == null ? null : Number(r.observedValue),
								sampleCount: Number(r.sampleCount ?? 0),
								windowMinutes: Number(r.windowMinutes ?? 0),
								windowStart: decodeIsoDateTimeStringSync(String(r.windowStart)),
								windowEnd: decodeIsoDateTimeStringSync(String(r.windowEnd)),
								consecutiveBreaches: Number(r.consecutiveBreaches ?? 0),
								consecutiveHealthy: Number(r.consecutiveHealthy ?? 0),
								incidentId:
									r.incidentId == null || r.incidentId === ""
										? null
										: decodeAlertIncidentIdSync(String(r.incidentId)),
								incidentTransition: decodeAlertIncidentTransitionSync(rawTransition),
								evaluationDurationMs: Number(r.evaluationDurationMs ?? 0),
								errorMessage:
									r.errorMessage == null || r.errorMessage === ""
										? null
										: String(r.errorMessage),
								errorCategory:
									r.errorCategory == null || r.errorCategory === ""
										? null
										: String(r.errorCategory),
							})
						}),
					catch: (error) =>
						new AlertPersistenceError({
							message: `Failed to decode alert check row: ${error instanceof Error ? error.message : String(error)}`,
						}),
				})

				return new AlertChecksListResponse({ checks })
			})

			const listDeliveryEvents = Effect.fn("AlertsService.listDeliveryEvents")(function* (
				orgId: OrgId,
			) {
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(alertDeliveryEvents)
						.where(eq(alertDeliveryEvents.orgId, orgId))
						.orderBy(desc(alertDeliveryEvents.createdAt))
						.limit(100),
				)

				const destinationRows = yield* dbExecute((db) =>
					db
						.select({
							id: alertDestinations.id,
							name: alertDestinations.name,
							type: alertDestinations.type,
						})
						.from(alertDestinations)
						.where(eq(alertDestinations.orgId, orgId)),
				)
				const destinationMap = new Map(destinationRows.map((row) => [row.id, row]))

				const events = rows.map((row) => {
					const destination = destinationMap.get(row.destinationId)
					return new AlertDeliveryEventDocument({
						id: decodeAlertDeliveryEventIdSync(row.id),
						incidentId: row.incidentId ? decodeAlertIncidentIdSync(row.incidentId) : null,
						ruleId: decodeAlertRuleIdSync(row.ruleId),
						destinationId: decodeAlertDestinationIdSync(row.destinationId),
						destinationName: destination?.name ?? "Deleted destination",
						destinationType:
							destination?.type != null
								? decodeAlertDestinationTypeSync(destination.type)
								: decodeAlertDestinationTypeSync("webhook"),
						deliveryKey: row.deliveryKey,
						eventType: decodeAlertEventTypeSync(row.eventType),
						attemptNumber: row.attemptNumber,
						status: decodeAlertDeliveryStatusSync(row.status),
						scheduledAt: decodeIsoDateTimeStringSync(row.scheduledAt.toISOString()),
						attemptedAt: toIso(row.attemptedAt),
						providerMessage: row.providerMessage,
						providerReference: row.providerReference,
						responseCode: row.responseCode,
						errorMessage: row.errorMessage,
					})
				})

				return new AlertDeliveryEventsListResponse({ events })
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

				const uniqueDestinationIds = [...new Set(rows.map((r) => r.destinationId))]
				const uniqueRuleIds = [...new Set(rows.map((r) => r.ruleId))]
				const uniqueIncidentIds = [
					...new Set(rows.filter((r) => r.incidentId != null).map((r) => r.incidentId!)),
				]

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
					const ruleServiceNames = ruleRow ? serviceNamesFromRow(ruleRow) : []
					const ruleGroupBy = ruleRow ? parseStoredGroupBy(ruleRow.groupBy) : null
					const groupKey = incidentRow?.groupKey ?? payloadRule?.groupKey ?? null

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
							signalType: decodeAlertSignalTypeSync(
								incidentRow?.signalType ?? payloadRule?.signalType ?? "throughput",
							),
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
							template:
								payload.template ??
								parseStoredNotificationTemplate(ruleRow?.notificationTemplateJson ?? null),
							linkUrl: resolveNotificationLinkUrl(
								{ serviceNames: ruleServiceNames, groupBy: ruleGroupBy },
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
					error: AlertValidationError | AlertDeliveryError | AlertPersistenceError,
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
					processOneDelivery(row).pipe(
						Effect.catchTags({
							"@maple/http/errors/AlertValidationError": (error) =>
								recoverDeliveryFailure(row, error),
							"@maple/http/errors/AlertDeliveryError": (error) =>
								recoverDeliveryFailure(row, error),
							"@maple/http/errors/AlertPersistenceError": (error) =>
								recoverDeliveryFailure(row, error),
						}),
					),
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
				pendingChecks: Ref.Ref<AlertChecksRow[]>,
				issueBudget: Ref.Ref<number>,
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
				const outcome = yield* Effect.gen(function* () {
					const state =
						(yield* dbExecute((db) =>
							db
								.select()
								.from(alertRuleStates)
								.where(
									and(
										eq(alertRuleStates.orgId, row.orgId),
										eq(alertRuleStates.ruleId, row.id),
										eq(alertRuleStates.groupKey, groupKey),
									),
								)
								.limit(1),
						))[0] ?? null

					// Look up the open incident for this group via the unique
					// (orgId, ruleId, status, groupKey) combination. The legacy
					// serviceName-based filter is gone — composite group keys make
					// serviceName ambiguous, and we now persist groupKey directly.
					const openIncident =
						(yield* dbExecute((db) =>
							db
								.select()
								.from(alertIncidents)
								.where(
									and(
										eq(alertIncidents.orgId, row.orgId),
										eq(alertIncidents.ruleId, row.id),
										eq(alertIncidents.status, "open"),
										eq(alertIncidents.groupKey, groupKey),
									),
								)
								.limit(1),
						))[0] ?? null

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
							lastNotifiedAt: null,
							errorIssueId: null,
							createdAt: new Date(timestamp),
							updatedAt: new Date(timestamp),
						}

						yield* dbExecute((db) => db.insert(alertIncidents).values(incident))
						yield* queueIncidentNotifications(
							row.orgId,
							normalized,
							incident,
							evaluation,
							"trigger",
							timestamp,
						)
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

						yield* dbExecute((db) =>
							db
								.update(alertIncidents)
								.set({
									lastTriggeredAt: new Date(timestamp),
									lastObservedValue: evaluation.value,
									lastSampleCount: evaluation.sampleCount,
									lastEvaluatedAt: new Date(timestamp),
									updatedAt: new Date(timestamp),
								})
								.where(eq(alertIncidents.id, openIncident.id)),
						)

						const renotifyDueAt =
							(openIncident.lastNotifiedAt ?? openIncident.firstTriggeredAt).getTime() +
							normalized.renotifyIntervalMinutes * 60_000
						if (renotifyDueAt <= timestamp) {
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

						yield* queueIncidentNotifications(
							row.orgId,
							normalized,
							resolvedIncident,
							evaluation,
							"resolve",
							timestamp,
						)
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
							workflowBinding: aiTriageWorkflowBinding,
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
				yield* Ref.update(pendingChecks, (rows) => {
					rows.push(checkRow)
					return rows
				})
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
				const staleGroupKeys = Arr.map(toResolve, (i) => i.groupKey ?? "__total__")

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
				) {
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

					const orphaned = Arr.filter(
						openIncidents,
						(i) => !HashSet.has(evaluatedGroups, i.groupKey ?? "__total__"),
					)

					if (orphaned.length === 0) return

					const syntheticEvaluation = makeSyntheticResolveEvaluation(
						normalized,
						"Auto-resolved: group no longer appears in evaluation results",
					)

					// Serialized per rule via claim lock + idempotent writes.
					yield* Effect.forEach(orphaned, (incident) => {
						const groupKey = incident.groupKey ?? "__total__"
						return Effect.gen(function* () {
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
						})
					})

					yield* Metric.update(AlertingMetrics.incidentsResolvedTotal, orphaned.length)
					yield* Metric.update(AlertingMetrics.staleIncidentsResolvedTotal, orphaned.length)
				},
			)

			const SCHEDULER_LOCK_TTL_MS = 30_000

			// Unchanged-state ticks skip the alert_rule_states upsert so the Electric
			// shape stays quiet; lastEvaluatedAt is refreshed at most this often.
			const STATE_HEARTBEAT_MS = 5 * 60_000

			const claimRule = (ruleId: AlertRuleId, timestamp: number) =>
				dbExecute((db) =>
					db
						.update(alertRules)
						.set({ lastScheduledAt: new Date(timestamp) })
						.where(
							and(
								eq(alertRules.id, ruleId),
								or(
									isNull(alertRules.lastScheduledAt),
									lt(alertRules.lastScheduledAt, new Date(timestamp - SCHEDULER_LOCK_TTL_MS)),
								),
							),
						)
						.returning({ id: alertRules.id }),
				)

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

				// Incremented from fibers running under the concurrent per-rule forEach
				// below, so it must be a Ref rather than a mutable closure variable.
				const evaluationFailureCount = yield* Ref.make(0)
				const pendingChecks = yield* Ref.make<AlertChecksRow[]>([])
				const issueBudget = yield* Ref.make(ISSUE_UPSERTS_PER_TICK)

				const recordEvaluationFailure = Effect.fnUntraced(function* (
					row: AlertRuleRow,
					error:
						| AlertValidationError
						| AlertDeliveryError
						| AlertNotFoundError
						| AlertPersistenceError
						| WarehouseError,
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
					yield* Ref.update(pendingChecks, (checks) => {
						checks.push({
							OrgId: row.orgId,
							RuleId: row.id,
							GroupKey: "__total__",
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
						})
						return checks
					})

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
											eq(alertRuleStates.groupKey, "__total__"),
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
									groupKey: "__total__",
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
								Effect.annotateLogs({ ruleId: row.id, message: persistError.message }),
							),
						),
						Effect.ignore,
					)
				})

				yield* Effect.forEach(
					rows,
					(row) =>
						Effect.gen(function* () {
							const timestamp = yield* now
							const claimed = yield* claimRule(row.id, timestamp)
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
											)
										}),
									)

									yield* resolveOrphanedGroupIncidents(
										row.orgId,
										normalized.id,
										normalized,
										HashSet.fromIterable(normalized.serviceNames),
										timestamp,
									)
									yield* Metric.update(
										AlertingMetrics.ruleEvaluationDurationMs,
										(yield* now) - ruleStart,
									)
									return
								}

								// Uniform grouped/ungrouped path. The engine always returns one
								// observation per group — a single "all" observation (with a
								// no-data fallback) when the compiled plan is ungrouped — so both
								// shapes flow through the same loop; ungrouped rules keep their
								// historical "__total__" storage key at this boundary.
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
											grouped ? groupKey : "__total__",
											timestamp,
											pendingChecks,
											issueBudget,
										)
									}),
								)

								const evaluatedGroups = grouped
									? HashSet.fromIterable(Arr.map(eligible, (r) => r.groupKey))
									: HashSet.fromIterable(["__total__"])
								yield* resolveOrphanedGroupIncidents(
									row.orgId,
									normalized.id,
									normalized,
									evaluatedGroups,
									timestamp,
								)

								// Self-heal state rows whose key shape contradicts the rule's
								// groupedness: a grouped rule can never legitimately own a
								// "__total__" row (left behind when this rule evaluated ungrouped,
								// or by recordEvaluationFailure), and vice versa. Orphan resolution
								// above only deletes incident-backed rows. Zero rows touched in
								// steady state, so the Electric shape stays quiet.
								yield* dbExecute((db) =>
									db
										.delete(alertRuleStates)
										.where(
											and(
												eq(alertRuleStates.orgId, row.orgId),
												eq(alertRuleStates.ruleId, row.id),
												grouped
													? eq(alertRuleStates.groupKey, "__total__")
													: ne(alertRuleStates.groupKey, "__total__"),
											),
										),
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
								Effect.tap(() =>
									dbExecute((db) =>
										db
											.update(alertRuleStates)
											.set({ lastError: null, updatedAt: new Date(timestamp) })
											.where(
												and(
													eq(alertRuleStates.orgId, row.orgId),
													eq(alertRuleStates.ruleId, row.id),
													isNotNull(alertRuleStates.lastError),
												),
											),
									).pipe(Effect.ignore),
								),
								Effect.catchTags({
									"@maple/http/errors/AlertValidationError": (error) =>
										recordEvaluationFailure(row, error, "validation"),
									"@maple/http/errors/AlertDeliveryError": (error) =>
										recordEvaluationFailure(row, error, "evaluation"),
									"@maple/http/errors/AlertPersistenceError": (error) =>
										recordEvaluationFailure(row, error, "unknown"),
									"@maple/http/errors/WarehouseQuotaExceededError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_quota", {
											quotaSetting: error.setting,
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseUpstreamError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_upstream", {
											upstreamStatus: error.upstreamStatus,
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseAuthError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_auth", {
											upstreamStatus: error.upstreamStatus,
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseConfigError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_config", {
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseClientError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_client", {
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseSchemaDriftError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_schema_drift", {
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseValidationError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_validation", {
											pipe: error.pipeName,
										}),
									"@maple/http/errors/WarehouseQueryError": (error) =>
										recordEvaluationFailure(row, error, "tinybird_query", {
											pipe: error.pipeName,
										}),
								}),
							)
						}),
					{ concurrency: 5 },
				)

				// Resolve stale incidents for disabled rules
				const disabledRulesWithOpenIncidents = yield* dbExecute((db) =>
					db
						.selectDistinct({ ruleId: alertIncidents.ruleId, orgId: alertIncidents.orgId })
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
				const accumulatedChecks = yield* Ref.getAndSet(pendingChecks, [])
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
						{ concurrency: "unbounded" },
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
				listDestinations,
				createDestination,
				updateDestination,
				deleteDestination,
				testDestination,
				listRules,
				createRule,
				updateRule,
				deleteRule,
				testRule,
				previewRule,
				listIncidents,
				listRuleChecks,
				listDeliveryEvents,
				runSchedulerTick,
			} satisfies AlertsServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
