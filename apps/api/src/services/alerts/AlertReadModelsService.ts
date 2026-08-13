import * as CH from "@maple/query-engine/ch"
import {
	AlertCheckDocument,
	AlertChecksListResponse,
	AlertComparator as AlertComparatorSchema,
	AlertDeliveryEventDocument,
	AlertDeliveryEventsListResponse,
	AlertDeliveryStatus,
	AlertDestinationDocument,
	AlertDestinationType as AlertDestinationTypeSchema,
	AlertEventType as AlertEventTypeSchema,
	AlertIncidentDocument,
	AlertIncidentsListResponse,
	AlertIncidentStatus,
	AlertIncidentTransition as AlertIncidentTransitionSchema,
	AlertIncidentNotFoundError,
	AlertRuleNotFoundError,
	AlertPersistenceError,
	AlertRuleDocument,
	AlertSeverity as AlertSeveritySchema,
	AlertSignalType as AlertSignalTypeSchema,
	AlertCheckStatus as AlertCheckStatusSchema,
	AlertValidationError,
	OrgId,
	RoleName,
	UserId,
	type AlertIncidentId,
	type AlertRuleId,
	type ManagedWarehouseError,
} from "@maple/domain/http"
import {
	alertDeliveryEvents,
	alertDestinations,
	alertIncidents,
	alertRules,
	type AlertIncidentRow,
} from "@maple/db"
import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { makeDbExecute } from "@/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import type { TenantContext } from "@/services/auth/AuthService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

export interface AlertChecksSummaryPoint {
	readonly bucket: string
	readonly groupKey: string
	readonly totalCount: number
	readonly breachedCount: number
	readonly healthyCount: number
	readonly skippedCount: number
	readonly errorCount: number
	readonly transitionCount: number
	readonly observedValue: number | null
	readonly threshold: number
}

export interface AlertChecksSummary {
	readonly bucketSeconds: number
	readonly topGroupKeys: ReadonlyArray<string>
	readonly points: ReadonlyArray<AlertChecksSummaryPoint>
	readonly totals: {
		readonly total: number
		readonly breached: number
		readonly healthy: number
		readonly skipped: number
		readonly error: number
		readonly transitions: number
	}
}

export interface ListAlertIncidentsOptions {
	readonly status?: AlertIncidentStatus
	readonly ruleId?: AlertRuleId
	readonly limit?: number
	readonly offset?: number
}

export interface ListAlertDeliveryEventsOptions {
	readonly limit?: number
	readonly offset?: number
}

export interface AlertReadModelsServiceShape {
	readonly listIncidents: (
		orgId: OrgId,
		options?: ListAlertIncidentsOptions,
	) => Effect.Effect<AlertIncidentsListResponse, AlertPersistenceError>
	readonly getIncident: (
		orgId: OrgId,
		incidentId: AlertIncidentId,
	) => Effect.Effect<AlertIncidentDocument, AlertPersistenceError | AlertIncidentNotFoundError>
	readonly listRuleChecks: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		options: {
			readonly groupKey?: string
			readonly status?: AlertCheckDocument["status"]
			readonly since?: string
			readonly until?: string
			readonly limit?: number
			readonly beforeTimestamp?: string
			readonly beforeGroupKey?: string
		},
	) => Effect.Effect<
		AlertChecksListResponse,
		AlertPersistenceError | AlertRuleNotFoundError | ManagedWarehouseError
	>
	readonly summarizeRuleChecks: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		options: {
			readonly since: string
			readonly until: string
		},
	) => Effect.Effect<
		AlertChecksSummary,
		AlertPersistenceError | AlertRuleNotFoundError | AlertValidationError | ManagedWarehouseError
	>
	readonly listDeliveryEvents: (
		orgId: OrgId,
		options?: ListAlertDeliveryEventsOptions,
	) => Effect.Effect<AlertDeliveryEventsListResponse, AlertPersistenceError>
}

const decodeAlertIncidentIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.id)
const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeAlertDeliveryEventIdSync = Schema.decodeUnknownSync(AlertDeliveryEventDocument.fields.id)
const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeAlertDestinationTypeSync = Schema.decodeUnknownSync(AlertDestinationTypeSchema)
const decodeAlertSeveritySync = Schema.decodeUnknownSync(AlertSeveritySchema)
const decodeAlertSignalTypeSync = Schema.decodeUnknownSync(AlertSignalTypeSchema)
const decodeAlertComparatorSync = Schema.decodeUnknownSync(AlertComparatorSchema)
const decodeAlertCheckStatusSync = Schema.decodeUnknownSync(AlertCheckStatusSchema)
const decodeAlertIncidentTransitionSync = Schema.decodeUnknownSync(AlertIncidentTransitionSchema)
const decodeAlertIncidentStatusSync = Schema.decodeUnknownSync(AlertIncidentStatus)
const decodeAlertEventTypeSync = Schema.decodeUnknownSync(AlertEventTypeSchema)
const decodeErrorIssueIdSync = Schema.decodeUnknownSync(AlertIncidentDocument.fields.errorIssueId)
const decodeAlertDeliveryStatusSync = Schema.decodeUnknownSync(AlertDeliveryStatus)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserId)

type IsoDateTimeValue = Schema.Schema.Type<typeof AlertDestinationDocument.fields.createdAt>

const toIso = (value: Date | null | undefined): IsoDateTimeValue | null =>
	value == null ? null : decodeIsoDateTimeStringSync(value.toISOString())

const makeValidationError = (message: string) => new AlertValidationError({ message, details: [] })

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

const toTinybirdSqlDateTime64 = (iso: string) => {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return null
	const pad = (n: number, w = 2) => n.toString().padStart(w, "0")
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

export class AlertReadModelsService extends Context.Service<
	AlertReadModelsService,
	AlertReadModelsServiceShape
>()("@maple/api/services/alerts/AlertReadModelsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const dbExecute = makeDbExecute(database, "AlertReadModelsService", makePersistenceError)

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: decodeUserIdSync("system-alerting"),
			roles: [decodeRoleNameSync("root")],
			authMode: "self_hosted",
		})

		const listIncidents = Effect.fn("AlertsService.listIncidents")(function* (
			orgId: OrgId,
			options: ListAlertIncidentsOptions = {},
		) {
			yield* Effect.annotateCurrentSpan({
				orgId,
				...(options.status !== undefined ? { status: options.status } : {}),
				...(options.ruleId !== undefined ? { ruleId: options.ruleId } : {}),
			})
			const conditions = [
				eq(alertIncidents.orgId, orgId),
				options.status ? eq(alertIncidents.status, options.status) : undefined,
				options.ruleId ? eq(alertIncidents.ruleId, options.ruleId) : undefined,
			].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined)
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(alertIncidents)
					.where(and(...conditions))
					.orderBy(desc(alertIncidents.lastTriggeredAt), desc(alertIncidents.id))
					.limit(options.limit ?? 100)
					.offset(options.offset ?? 0),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
			return new AlertIncidentsListResponse({
				incidents: rows.map(rowToIncidentDocument),
			})
		})

		const getIncident = Effect.fn("AlertsService.getIncident")(function* (
			orgId: OrgId,
			incidentId: AlertIncidentId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, incidentId })
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(alertIncidents)
					.where(and(eq(alertIncidents.orgId, orgId), eq(alertIncidents.id, incidentId)))
					.limit(1),
			)
			const incident = rows[0]
			if (incident === undefined) {
				return yield* new AlertIncidentNotFoundError({
					message: `No such alert incident: '${incidentId}'`,
					incidentId,
				})
			}
			return rowToIncidentDocument(incident)
		})

		const listRuleChecks = Effect.fn("AlertsService.listRuleChecks")(function* (
			orgId: OrgId,
			ruleId: AlertRuleId,
			options: {
				readonly groupKey?: string
				readonly status?: AlertCheckDocument["status"]
				readonly since?: string
				readonly until?: string
				readonly limit?: number
				readonly beforeTimestamp?: string
				readonly beforeGroupKey?: string
			},
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
			// Verify the rule exists and belongs to this org before querying Tinybird.
			const ruleRow = yield* dbExecute((db) =>
				db
					.select({ id: alertRules.id })
					.from(alertRules)
					.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
					.limit(1),
			)
			if (ruleRow.length === 0) {
				return yield* new AlertRuleNotFoundError({
					message: "Alert rule not found",
					ruleId,
				})
			}

			const clamp = (n: number | undefined, min: number, max: number, fallback: number) => {
				if (n == null || Number.isNaN(n)) return fallback
				return Math.min(max, Math.max(min, Math.trunc(n)))
			}
			const limit = clamp(options.limit, 1, 2000, 500)

			const since = options.since != null ? toTinybirdSqlDateTime64(options.since) : null
			const until = options.until != null ? toTinybirdSqlDateTime64(options.until) : null
			const beforeTimestamp =
				options.beforeTimestamp != null ? toTinybirdSqlDateTime64(options.beforeTimestamp) : null
			const hasGroupKey = options.groupKey != null && options.groupKey !== ""

			const compiled = CH.compile(
				CH.listRuleChecksQuery({
					limit,
					groupKey: hasGroupKey ? options.groupKey : undefined,
					status: options.status,
					since: since ?? undefined,
					until: until ?? undefined,
					beforeTimestamp: beforeTimestamp ?? undefined,
					beforeGroupKey: beforeTimestamp != null ? (options.beforeGroupKey ?? "") : undefined,
				}),
				{
					orgId,
					ruleId,
					...(hasGroupKey ? { groupKey: options.groupKey } : {}),
					...(options.status != null ? { status: options.status } : {}),
					...(since != null ? { since } : {}),
					...(until != null ? { until } : {}),
					...(beforeTimestamp != null
						? {
								beforeTimestamp,
								beforeGroupKey: options.beforeGroupKey ?? "",
							}
						: {}),
				},
			)

			// listRuleChecksQuery declares .routing("ingest") — alert_checks only
			// exists in the managed Tinybird pipeline.
			const rows = yield* warehouse.compiledQuery(systemTenant(orgId), compiled, {
				profile: "list",
				context: "listAlertChecks",
			})

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

		const summarizeRuleChecks = Effect.fn("AlertsService.summarizeRuleChecks")(function* (
			orgId: OrgId,
			ruleId: AlertRuleId,
			options: { readonly since: string; readonly until: string },
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.rule_id": ruleId })
			const ruleRow = yield* dbExecute((db) =>
				db
					.select({ id: alertRules.id })
					.from(alertRules)
					.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
					.limit(1),
			)
			if (ruleRow.length === 0) {
				return yield* new AlertRuleNotFoundError({
					message: "Alert rule not found",
					ruleId,
				})
			}

			const startMs = Date.parse(options.since)
			const endMs = Date.parse(options.until)
			const maxRangeMs = 365 * 24 * 60 * 60 * 1000
			if (
				!Number.isFinite(startMs) ||
				!Number.isFinite(endMs) ||
				endMs <= startMs ||
				endMs - startMs > maxRangeMs
			) {
				return yield* Effect.fail(
					makeValidationError("Alert check summaries require a valid range of at most 365 days"),
				)
			}
			const since = toTinybirdSqlDateTime64(options.since)
			const until = toTinybirdSqlDateTime64(options.until)
			if (since == null || until == null) {
				return yield* Effect.fail(makeValidationError("Invalid alert check summary range"))
			}

			// At most 720 time buckets; minute alignment keeps the boundaries
			// stable across refreshes and matches alert evaluation granularity.
			const bucketSeconds = Math.max(1, Math.ceil((endMs - startMs) / 1000 / 720 / 60)) * 60
			const tenant = systemTenant(orgId)
			const groupRows = yield* warehouse.compiledQuery(
				tenant,
				CH.compile(CH.alertCheckGroupTotalsQuery({ since, until, limit: 20 }), {
					orgId,
					ruleId,
					since,
					until,
				}),
				{ profile: "aggregation", context: "alertCheckSummaryGroups" },
			)
			const topGroupKeys = groupRows.map((row) => String(row.groupKey ?? ""))
			const rows = yield* warehouse.compiledQuery(
				tenant,
				CH.compile(CH.alertChecksSummaryQuery({ topGroupKeys }), {
					orgId,
					ruleId,
					since,
					until,
					bucketSeconds,
				}),
				{ profile: "aggregation", context: "alertCheckSummary" },
			)

			const points: AlertChecksSummaryPoint[] = rows.map((row) => ({
				bucket: String(row.bucket),
				groupKey: String(row.groupKey ?? ""),
				totalCount: Number(row.totalCount ?? 0),
				breachedCount: Number(row.breachedCount ?? 0),
				healthyCount: Number(row.healthyCount ?? 0),
				skippedCount: Number(row.skippedCount ?? 0),
				errorCount: Number(row.errorCount ?? 0),
				transitionCount: Number(row.transitionCount ?? 0),
				observedValue: row.observedValue == null ? null : Number(row.observedValue),
				threshold: Number(row.threshold ?? 0),
			}))
			const totals = points.reduce(
				(acc, point) => ({
					total: acc.total + point.totalCount,
					breached: acc.breached + point.breachedCount,
					healthy: acc.healthy + point.healthyCount,
					skipped: acc.skipped + point.skippedCount,
					error: acc.error + point.errorCount,
					transitions: acc.transitions + point.transitionCount,
				}),
				{ total: 0, breached: 0, healthy: 0, skipped: 0, error: 0, transitions: 0 },
			)
			return { bucketSeconds, topGroupKeys, points, totals } satisfies AlertChecksSummary
		})

		const listDeliveryEvents = Effect.fn("AlertsService.listDeliveryEvents")(function* (
			orgId: OrgId,
			options: ListAlertDeliveryEventsOptions = {},
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(alertDeliveryEvents)
					.where(eq(alertDeliveryEvents.orgId, orgId))
					.orderBy(desc(alertDeliveryEvents.createdAt), desc(alertDeliveryEvents.id))
					.limit(options.limit ?? 100)
					.offset(options.offset ?? 0),
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

		return {
			listIncidents,
			getIncident,
			listRuleChecks,
			summarizeRuleChecks,
			listDeliveryEvents,
		} satisfies AlertReadModelsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
