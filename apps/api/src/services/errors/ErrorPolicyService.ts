import {
	type AlertDestinationId,
	ErrorNotificationPolicyDocument,
	type ErrorNotificationPolicyUpsertRequest,
	ErrorPersistenceError,
	ErrorValidationError,
	EscalationDestinationOutcome,
	EscalationPolicyEvaluationDocument,
	type EscalationPolicyEvaluationRequest,
	EscalationSkipReason,
	IssueEscalationAttemptDocument,
	IssueEscalationAttemptsResponse,
	IssueEscalationPolicyDocument,
	IssueEscalationPolicyRule,
	type IssueEscalationPolicyUpsertRequest,
	type ErrorIssueId,
	type OrgId,
	type UserId,
	UserId as UserIdSchema,
} from "@maple/domain/http"
import {
	alertDestinations,
	errorNotificationPolicies,
	type ErrorNotificationPolicyRow,
	issueEscalationPolicies,
	type IssueEscalationPolicyRow,
	issueEscalations,
	type IssueEscalationRow,
} from "@maple/db"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Array as Arr, Clock, Context, Effect, HashSet, Layer, Option, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import { evaluateEscalationPolicy as evaluateRoutingPolicy } from "@/services/alerts/escalation-policy"
import { makeErrorDatabaseExecute } from "./error-persistence"

const decodeAlertDestinationIds = Schema.decodeUnknownOption(
	ErrorNotificationPolicyDocument.fields.destinationIds,
)
const decodeStoredJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const decodeEscalationRules = Schema.decodeUnknownOption(Schema.Array(IssueEscalationPolicyRule))
const decodeEscalationDeliveries = Schema.decodeUnknownOption(Schema.Array(EscalationDestinationOutcome))
const decodeEscalationSkipReason = Schema.decodeUnknownOption(EscalationSkipReason)
const decodeNotificationUpdatedAt = Schema.decodeUnknownSync(ErrorNotificationPolicyDocument.fields.updatedAt)
const decodeEscalationUpdatedAt = Schema.decodeUnknownSync(IssueEscalationPolicyDocument.fields.updatedAt)
const decodeEscalationAttemptCreatedAt = Schema.decodeUnknownSync(
	IssueEscalationAttemptDocument.fields.createdAt,
)
const decodeEscalationAttemptProcessedAt = Schema.decodeUnknownSync(
	IssueEscalationAttemptDocument.fields.processedAt,
)

export interface ErrorPolicyPublicShape {
	readonly getNotificationPolicy: (
		orgId: OrgId,
	) => Effect.Effect<ErrorNotificationPolicyDocument, ErrorPersistenceError>
	readonly upsertNotificationPolicy: (
		orgId: OrgId,
		userId: UserId,
		request: ErrorNotificationPolicyUpsertRequest,
	) => Effect.Effect<ErrorNotificationPolicyDocument, ErrorPersistenceError | ErrorValidationError>
	readonly getEscalationPolicy: (
		orgId: OrgId,
	) => Effect.Effect<IssueEscalationPolicyDocument, ErrorPersistenceError>
	readonly upsertEscalationPolicy: (
		orgId: OrgId,
		userId: UserId,
		request: IssueEscalationPolicyUpsertRequest,
	) => Effect.Effect<IssueEscalationPolicyDocument, ErrorPersistenceError | ErrorValidationError>
	readonly evaluateEscalationPolicy: (
		orgId: OrgId,
		request: EscalationPolicyEvaluationRequest,
	) => Effect.Effect<EscalationPolicyEvaluationDocument, ErrorPersistenceError>
	readonly listIssueEscalations: (
		orgId: OrgId,
		issueId: ErrorIssueId,
	) => Effect.Effect<IssueEscalationAttemptsResponse, ErrorPersistenceError>
	readonly listRecentEscalations: (
		orgId: OrgId,
		limit?: number,
	) => Effect.Effect<IssueEscalationAttemptsResponse, ErrorPersistenceError>
}

/** Policy persistence shared with the compatibility facade's notification and tick paths. */
export interface ErrorPolicyServiceShape extends ErrorPolicyPublicShape {
	readonly defaultNotificationPolicy: (orgId: OrgId, timestamp: number) => ErrorNotificationPolicyRow
	readonly parseNotificationDestinationIds: (raw: unknown) => ReadonlyArray<AlertDestinationId>
	readonly loadNotificationPolicyRow: (
		orgId: OrgId,
	) => Effect.Effect<ErrorNotificationPolicyRow | null, ErrorPersistenceError>
}

const make: Effect.Effect<ErrorPolicyServiceShape, never, Database> = Effect.gen(function* () {
	const database = yield* Database
	const dbExecute = makeErrorDatabaseExecute(database, "ErrorPolicyService")
	const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)

	// Mirrors the column defaults on `error_notification_policies` — an org with no
	// row must behave exactly like an org that just got one. Notifications are
	// enabled but route nowhere until a destination is picked, so the empty
	// `destinationIdsJson` (not `enabled`) is what holds delivery back. Setting
	// `enabled: false` here instead made CFG-NOTIF-01 report "turned off" for
	// row-less orgs and hid the real reason.
	const defaultNotificationPolicy: ErrorPolicyServiceShape["defaultNotificationPolicy"] = (
		orgId,
		timestamp,
	) => ({
		orgId,
		enabled: true,
		destinationIdsJson: [],
		notifyOnFirstSeen: true,
		notifyOnRegression: true,
		notifyOnResolve: false,
		notifyOnTransitionInReview: false,
		notifyOnTransitionDone: false,
		notifyOnClaim: false,
		minOccurrenceCount: 1,
		severity: "warning",
		updatedAt: msToDate(timestamp),
		updatedBy: "system",
	})

	const parseNotificationDestinationIds: ErrorPolicyServiceShape["parseNotificationDestinationIds"] = (
		raw,
	) =>
		Option.getOrElse(
			Option.flatMap(decodeStoredJsonArray(raw), (parsed) =>
				decodeAlertDestinationIds(parsed.filter((value) => typeof value === "string")),
			),
			() => [],
		)

	const notificationRowToDocument = (row: ErrorNotificationPolicyRow) =>
		new ErrorNotificationPolicyDocument({
			enabled: row.enabled,
			destinationIds: parseNotificationDestinationIds(row.destinationIdsJson),
			notifyOnFirstSeen: row.notifyOnFirstSeen,
			notifyOnRegression: row.notifyOnRegression,
			notifyOnResolve: row.notifyOnResolve,
			notifyOnTransitionInReview: row.notifyOnTransitionInReview,
			notifyOnTransitionDone: row.notifyOnTransitionDone,
			notifyOnClaim: row.notifyOnClaim,
			minOccurrenceCount: row.minOccurrenceCount,
			severity: row.severity,
			updatedAt: decodeNotificationUpdatedAt(row.updatedAt.toISOString()),
			updatedBy: decodeUserIdSync(row.updatedBy),
		})

	const loadNotificationPolicyRow: ErrorPolicyServiceShape["loadNotificationPolicyRow"] = Effect.fn(
		"ErrorsService.loadPolicyRow",
	)(function* (orgId) {
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(errorNotificationPolicies)
				.where(eq(errorNotificationPolicies.orgId, orgId))
				.limit(1),
		)
		return rows[0] ?? null
	})

	const getNotificationPolicy: ErrorPolicyServiceShape["getNotificationPolicy"] = Effect.fn(
		"ErrorsService.getNotificationPolicy",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const row = yield* loadNotificationPolicyRow(orgId)
		const nowMs = yield* Clock.currentTimeMillis
		return notificationRowToDocument(row ?? defaultNotificationPolicy(orgId, nowMs))
	})

	const upsertNotificationPolicy: ErrorPolicyServiceShape["upsertNotificationPolicy"] = Effect.fn(
		"ErrorsService.upsertNotificationPolicy",
	)(function* (orgId, userId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const existing = yield* loadNotificationPolicyRow(orgId)
		const timestamp = yield* Clock.currentTimeMillis
		const base = existing ?? defaultNotificationPolicy(orgId, timestamp)

		const nextDestinations =
			request.destinationIds !== undefined ? request.destinationIds : base.destinationIdsJson
		const toFlag = (value: boolean | undefined, fallback: boolean): boolean =>
			value === undefined ? fallback : value

		const merged: ErrorNotificationPolicyRow = {
			orgId,
			enabled: toFlag(request.enabled, base.enabled),
			destinationIdsJson: nextDestinations,
			notifyOnFirstSeen: toFlag(request.notifyOnFirstSeen, base.notifyOnFirstSeen),
			notifyOnRegression: toFlag(request.notifyOnRegression, base.notifyOnRegression),
			notifyOnResolve: toFlag(request.notifyOnResolve, base.notifyOnResolve),
			notifyOnTransitionInReview: toFlag(
				request.notifyOnTransitionInReview,
				base.notifyOnTransitionInReview,
			),
			notifyOnTransitionDone: toFlag(request.notifyOnTransitionDone, base.notifyOnTransitionDone),
			notifyOnClaim: toFlag(request.notifyOnClaim, base.notifyOnClaim),
			minOccurrenceCount:
				request.minOccurrenceCount !== undefined
					? request.minOccurrenceCount
					: base.minOccurrenceCount,
			severity: request.severity !== undefined ? request.severity : base.severity,
			updatedAt: msToDate(timestamp),
			updatedBy: userId,
		}

		yield* dbExecute((db) =>
			db
				.insert(errorNotificationPolicies)
				.values(merged)
				.onConflictDoUpdate({
					target: errorNotificationPolicies.orgId,
					set: {
						enabled: merged.enabled,
						destinationIdsJson: merged.destinationIdsJson,
						notifyOnFirstSeen: merged.notifyOnFirstSeen,
						notifyOnRegression: merged.notifyOnRegression,
						notifyOnResolve: merged.notifyOnResolve,
						notifyOnTransitionInReview: merged.notifyOnTransitionInReview,
						notifyOnTransitionDone: merged.notifyOnTransitionDone,
						notifyOnClaim: merged.notifyOnClaim,
						minOccurrenceCount: merged.minOccurrenceCount,
						severity: merged.severity,
						updatedAt: merged.updatedAt,
						updatedBy: merged.updatedBy,
					},
				}),
		)

		return notificationRowToDocument(merged)
	})

	const escalationRowToDocument = (row: IssueEscalationPolicyRow | null) =>
		new IssueEscalationPolicyDocument({
			enabled: row?.enabled ?? false,
			rules: row == null ? [] : Option.getOrElse(decodeEscalationRules(row.rulesJson), () => []),
			updatedAt: row == null ? null : decodeEscalationUpdatedAt(row.updatedAt.toISOString()),
			updatedBy: row == null || row.updatedBy === "system" ? null : decodeUserIdSync(row.updatedBy),
		})

	const loadEscalationPolicyRow = Effect.fn("ErrorsService.loadEscalationPolicyRow")(function* (
		orgId: OrgId,
	) {
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(issueEscalationPolicies)
				.where(eq(issueEscalationPolicies.orgId, orgId))
				.limit(1),
		)
		return rows[0] ?? null
	})

	const getEscalationPolicy: ErrorPolicyServiceShape["getEscalationPolicy"] = Effect.fn(
		"ErrorsService.getEscalationPolicy",
	)(function* (orgId) {
		yield* Effect.annotateCurrentSpan({ orgId })
		return escalationRowToDocument(yield* loadEscalationPolicyRow(orgId))
	})

	const upsertEscalationPolicy: ErrorPolicyServiceShape["upsertEscalationPolicy"] = Effect.fn(
		"ErrorsService.upsertEscalationPolicy",
	)(function* (orgId, userId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const existing = yield* loadEscalationPolicyRow(orgId)
		const timestamp = yield* Clock.currentTimeMillis

		if (request.rules !== undefined) {
			const seen = new Set<string>()
			for (const rule of request.rules) {
				if (seen.has(rule.severity)) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: "Escalation policy has duplicate severity rules",
							details: [rule.severity],
						}),
					)
				}
				seen.add(rule.severity)
			}

			// Reject destination IDs that don't belong to this org at write time.
			// Dispatch re-filters by org anyway (no cross-org leak), but a typo'd
			// or foreign ID would otherwise only surface much later as a silently
			// "skipped" escalation with reason no_enabled_destinations.
			const referencedIds = Arr.dedupe(Arr.flatMap(request.rules, (rule) => rule.destinationIds))
			if (referencedIds.length > 0) {
				const ownedRows = yield* dbExecute((db) =>
					db
						.select({ id: alertDestinations.id })
						.from(alertDestinations)
						.where(
							and(
								eq(alertDestinations.orgId, orgId),
								inArray(alertDestinations.id, referencedIds),
							),
						),
				)
				const owned = HashSet.fromIterable(Arr.map(ownedRows, (row) => row.id))
				const unknown = Arr.filter(referencedIds, (id) => !HashSet.has(owned, id))
				if (unknown.length > 0) {
					return yield* Effect.fail(
						new ErrorValidationError({
							message: "Escalation policy references unknown destinations",
							details: unknown,
						}),
					)
				}
			}
		}

		const merged: IssueEscalationPolicyRow = {
			orgId,
			enabled: request.enabled !== undefined ? request.enabled : (existing?.enabled ?? false),
			rulesJson: request.rules !== undefined ? request.rules : (existing?.rulesJson ?? []),
			updatedAt: msToDate(timestamp),
			updatedBy: userId,
		}

		yield* dbExecute((db) =>
			db
				.insert(issueEscalationPolicies)
				.values(merged)
				.onConflictDoUpdate({
					target: issueEscalationPolicies.orgId,
					set: {
						enabled: merged.enabled,
						rulesJson: merged.rulesJson,
						updatedAt: merged.updatedAt,
						updatedBy: merged.updatedBy,
					},
				}),
		)

		return escalationRowToDocument(merged)
	})

	const escalationAttemptDocument = (row: IssueEscalationRow) =>
		new IssueEscalationAttemptDocument({
			id: row.id,
			issueId: row.issueId,
			investigationId: row.investigationId,
			severity: row.severity,
			source: row.source,
			reason: row.reason,
			status: row.status,
			attempts: row.attempts,
			skipReason:
				row.status === "skipped" ? Option.getOrNull(decodeEscalationSkipReason(row.error)) : null,
			deliveries: Option.getOrElse(decodeEscalationDeliveries(row.deliveryResultsJson), () => []),
			createdAt: decodeEscalationAttemptCreatedAt(row.createdAt.toISOString()),
			processedAt:
				row.processedAt == null
					? null
					: decodeEscalationAttemptProcessedAt(row.processedAt.toISOString()),
		})

	const evaluatePolicy: ErrorPolicyServiceShape["evaluateEscalationPolicy"] = Effect.fn(
		"ErrorsService.evaluateEscalationPolicy",
	)(function* (orgId, request) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const policy = yield* loadEscalationPolicyRow(orgId)
		const rules =
			policy == null ? [] : Option.getOrElse(decodeEscalationRules(policy.rulesJson), () => [])
		const referencedIds = Arr.dedupe(Arr.flatMap(rules, (rule) => rule.destinationIds))
		const enabledRows =
			referencedIds.length === 0
				? []
				: yield* dbExecute((db) =>
						db
							.select({ id: alertDestinations.id })
							.from(alertDestinations)
							.where(
								and(
									eq(alertDestinations.orgId, orgId),
									eq(alertDestinations.enabled, true),
									inArray(alertDestinations.id, referencedIds),
								),
							),
					)
		const decision = evaluateRoutingPolicy({
			enabled: policy?.enabled ?? false,
			rules,
			severity: request.severity,
			source: request.source,
			...(request.confidence === undefined ? {} : { confidence: request.confidence }),
			enabledDestinationIds: new Set(enabledRows.map((row) => row.id)),
		})
		return new EscalationPolicyEvaluationDocument({
			outcome: decision.outcome,
			destinationIds: [...decision.destinationIds],
			skipReason: decision.skipReason,
		})
	})

	const listIssueEscalations: ErrorPolicyServiceShape["listIssueEscalations"] = Effect.fn(
		"ErrorsService.listIssueEscalations",
	)(function* (orgId, issueId) {
		yield* Effect.annotateCurrentSpan({ orgId, issueId })
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(issueEscalations)
				.where(and(eq(issueEscalations.orgId, orgId), eq(issueEscalations.issueId, issueId)))
				.orderBy(desc(issueEscalations.createdAt)),
		)
		return new IssueEscalationAttemptsResponse({ attempts: rows.map(escalationAttemptDocument) })
	})

	const listRecentEscalations: ErrorPolicyServiceShape["listRecentEscalations"] = Effect.fn(
		"ErrorsService.listRecentEscalations",
	)(function* (orgId, limit) {
		yield* Effect.annotateCurrentSpan({ orgId })
		const rows = yield* dbExecute((db) =>
			db
				.select()
				.from(issueEscalations)
				.where(eq(issueEscalations.orgId, orgId))
				.orderBy(desc(issueEscalations.createdAt))
				.limit(limit ?? 25),
		)
		return new IssueEscalationAttemptsResponse({ attempts: rows.map(escalationAttemptDocument) })
	})

	return {
		getNotificationPolicy,
		upsertNotificationPolicy,
		getEscalationPolicy,
		upsertEscalationPolicy,
		evaluateEscalationPolicy: evaluatePolicy,
		listIssueEscalations,
		listRecentEscalations,
		defaultNotificationPolicy,
		parseNotificationDestinationIds,
		loadNotificationPolicyRow,
	} satisfies ErrorPolicyServiceShape
})

export class ErrorPolicyService extends Context.Service<ErrorPolicyService, ErrorPolicyServiceShape>()(
	"@maple/api/services/errors/ErrorPolicyService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
