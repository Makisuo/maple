import {
	AlertForbiddenError,
	AlertNotFoundError,
	AlertPersistenceError,
	AlertRuleDeleteResponse,
	AlertRuleDocument,
	AlertRulesListResponse,
	AlertValidationError,
	RoleName,
	type AlertDestinationId,
	type AlertRuleId,
	type AlertRuleUpsertRequest,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import {
	alertDeliveryEvents,
	alertDestinations,
	alertIncidents,
	alertRuleClaims,
	alertRules,
	alertRuleStates,
} from "@maple/db"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Array as Arr, Context, Effect, HashSet, Layer, Schema } from "effect"
import { Database, type DatabaseShape } from "@/platform/DatabaseLive"
import { makeDbExecute } from "@/platform/db-execute"
import { readTxid, txidColumn } from "@/platform/electric-txid"
import { dateToMs, msToDate } from "@/platform/time"
import {
	makeAlertRuleNormalizer,
	makeAlertValidationError,
	normalizeOptionalString,
	rowToRuleDocument,
	safeParseStringArray,
	type RuleEvaluationState,
} from "./AlertRuleModel"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime, type AlertRuntimeShape } from "./AlertRuntime"

const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const adminRoles = [decodeRoleNameSync("root"), decodeRoleNameSync("org:admin")]
const MAX_ACTIVE_ALERT_RULES_PER_ORG = 100

const isAdmin = (roles: ReadonlyArray<RoleName>) => roles.some((role) => adminRoles.includes(role))

export interface AlertRulesServiceShape {
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
	readonly deleteRule: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
	) => Effect.Effect<
		AlertRuleDeleteResponse,
		AlertForbiddenError | AlertPersistenceError | AlertNotFoundError
	>
}

export const makeAlertRulePersistence = (options: {
	readonly database: DatabaseShape
	readonly runtime: AlertRuntimeShape
}) => {
	const { database, runtime } = options
	const { normalizeRule, normalizeRuleRow } = makeAlertRuleNormalizer(runtime)

	const dbExecute = makeDbExecute(database, "AlertRulesService", makePersistenceError)

	const requireAdmin = Effect.fn("AlertsService.requireAdmin")(function* (roles: ReadonlyArray<RoleName>) {
		if (isAdmin(roles)) return
		return yield* Effect.fail(
			new AlertForbiddenError({
				message: "Only org admins can manage alerts",
				...(roles.length > 0 ? { roles: [...roles] } : {}),
			}),
		)
	})

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
		const existingIds = HashSet.fromIterable(Arr.map(rows, (row) => row.id))
		const missing = Arr.filter(destinationIds, (id) => !HashSet.has(existingIds, id))
		if (missing.length > 0) {
			return yield* Effect.fail(makeAlertValidationError("Unknown destination IDs", missing))
		}
	})

	const upsertRuleRow = Effect.fn("AlertsService.upsertRuleRow")(function* (
		orgId: OrgId,
		userId: UserId,
		existingId: AlertRuleId | null,
		request: AlertRuleUpsertRequest,
	) {
		const normalized = yield* normalizeRule(orgId, request)
		yield* requireDestinationIds(orgId, normalized.destinationIds)
		const ruleId = existingId ?? normalized.id
		const timestamp = yield* runtime.now
		const ruleFields = {
			name: normalized.name,
			notes: normalizeOptionalString(request.notes),
			notificationTemplateJson: normalized.notificationTemplate ?? null,
			enabled: normalized.enabled,
			severity: normalized.severity,
			serviceNamesJson: normalized.serviceNames.length > 0 ? normalized.serviceNames : null,
			excludeServiceNamesJson:
				normalized.excludeServiceNames.length > 0 ? normalized.excludeServiceNames : null,
			environmentsJson: normalized.environments.length > 0 ? normalized.environments : null,
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
			apdexThresholdMs: normalized.apdexThresholdMs,
			queryBuilderDraftJson: normalized.queryBuilderDraft ?? null,
			rawQuerySql: normalized.rawQuerySql,
			destinationIdsJson: normalized.destinationIds,
			querySpecJson: normalized.compiledPlan.query ?? null,
			reducer: normalized.compiledPlan.reducer,
			sampleCountStrategy: normalized.compiledPlan.sampleCountStrategy,
			noDataBehavior: normalized.compiledPlan.noDataBehavior,
			updatedAt: msToDate(timestamp),
			updatedBy: userId,
		} as const

		const writeResult = yield* dbExecute((db) =>
			db.transaction(async (tx) => {
				await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}))`)
				if (normalized.enabled) {
					const activeRows = await tx
						.select({ id: alertRules.id })
						.from(alertRules)
						.where(and(eq(alertRules.orgId, orgId), eq(alertRules.enabled, true)))
					const alreadyActive =
						existingId != null && activeRows.some((row) => row.id === existingId)
					if (!alreadyActive && activeRows.length >= MAX_ACTIVE_ALERT_RULES_PER_ORG) {
						return { limitExceeded: true as const, writeRows: [] }
					}
				}

				const writeRows =
					existingId == null
						? await tx
								.insert(alertRules)
								.values({
									id: ruleId,
									orgId,
									...ruleFields,
									createdAt: msToDate(timestamp),
									createdBy: userId,
								})
								.returning(txidColumn)
						: await tx
								.update(alertRules)
								.set(ruleFields)
								.where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, existingId)))
								.returning(txidColumn)
				return { limitExceeded: false as const, writeRows }
			}),
		)
		if (writeResult.limitExceeded) {
			return yield* Effect.fail(
				makeAlertValidationError(
					`Organizations may have at most ${MAX_ACTIVE_ALERT_RULES_PER_ORG} active alert rules`,
				),
			)
		}
		const txid = readTxid(writeResult.writeRows)
		const row = yield* requireRuleRow(orgId, ruleId)
		const document = rowToRuleDocument(row, safeParseStringArray(row.destinationIdsJson))
		return txid === undefined ? document : new AlertRuleDocument({ ...document, txid })
	})

	const listRules = Effect.fn("AlertsService.listRules")(function* (orgId: OrgId) {
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(alertRules)
				.where(eq(alertRules.orgId, orgId))
				.orderBy(desc(alertRules.createdAt), desc(alertRules.id)),
		)
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
			if (existing == null || (dateToMs(state.lastEvaluatedAt) ?? 0) > (existing.evaluatedAt ?? 0)) {
				errorByRule.set(state.ruleId, {
					error: state.lastError,
					evaluatedAt: dateToMs(state.lastEvaluatedAt),
				})
			}
		}
		return new AlertRulesListResponse({
			rules: rows.map((row) =>
				rowToRuleDocument(row, safeParseStringArray(row.destinationIdsJson), errorByRule.get(row.id)),
			),
		})
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

	const deleteRule = Effect.fn("AlertsService.deleteRule")(function* (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		ruleId: AlertRuleDocument["id"],
	) {
		yield* requireAdmin(roles)
		yield* requireRuleRow(orgId, ruleId)
		const deleted = yield* dbExecute((db) =>
			db.transaction(async (tx) => {
				await tx
					.delete(alertDeliveryEvents)
					.where(and(eq(alertDeliveryEvents.orgId, orgId), eq(alertDeliveryEvents.ruleId, ruleId)))
				await tx
					.delete(alertIncidents)
					.where(and(eq(alertIncidents.orgId, orgId), eq(alertIncidents.ruleId, ruleId)))
				await tx
					.delete(alertRuleStates)
					.where(and(eq(alertRuleStates.orgId, orgId), eq(alertRuleStates.ruleId, ruleId)))
				await tx.delete(alertRuleClaims).where(eq(alertRuleClaims.ruleId, ruleId))
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

	return {
		listRules,
		createRule,
		deleteRule,
		requireAdmin,
		normalizeRule,
		normalizeRuleRow,
		requireRuleRow,
		requireDestinationIds,
		upsertRuleRow,
	}
}

export class AlertRulesService extends Context.Service<AlertRulesService, AlertRulesServiceShape>()(
	"@maple/api/services/alerts/AlertRulesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const runtime = yield* AlertRuntime
			const persistence = makeAlertRulePersistence({ database, runtime })
			return {
				listRules: persistence.listRules,
				createRule: persistence.createRule,
				deleteRule: persistence.deleteRule,
			} satisfies AlertRulesServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
