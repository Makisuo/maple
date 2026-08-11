import { randomUUID } from "node:crypto"
import {
	IsoDateTimeString,
	OrgId,
	RecommendationIssue,
	RecommendationIssueId,
	RecommendationIssueKind,
	RecommendationIssueNotFoundError,
	RecommendationIssuePersistenceError,
	RecommendationIssuesListResponse,
	RecommendationIssueStatus,
} from "@maple/domain/http"
import { detectAttributeRecommendations, planReconcileIssues } from "@maple/domain/recommendations"
import { orgIngestAttributeMappings, orgRecommendationIssues } from "@maple/db"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { and, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

type IssueRow = typeof orgRecommendationIssues.$inferSelect

export interface RecommendationIssueServiceShape {
	/** Reconciles live telemetry → persisted issues, then returns the full numbered list. */
	readonly listReconciled: (
		tenant: TenantContext,
	) => Effect.Effect<RecommendationIssuesListResponse, RecommendationIssuePersistenceError>
	readonly dismiss: (
		tenant: TenantContext,
		id: RecommendationIssueId,
	) => Effect.Effect<
		RecommendationIssuesListResponse,
		RecommendationIssueNotFoundError | RecommendationIssuePersistenceError
	>
	readonly reopen: (
		tenant: TenantContext,
		id: RecommendationIssueId,
	) => Effect.Effect<
		RecommendationIssuesListResponse,
		RecommendationIssueNotFoundError | RecommendationIssuePersistenceError
	>
}

const decodeIssueIdSync = Schema.decodeUnknownSync(RecommendationIssueId)
const decodeKindSync = Schema.decodeUnknownSync(RecommendationIssueKind)
const decodeStatusSync = Schema.decodeUnknownSync(RecommendationIssueStatus)
const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)

const toPersistenceError = (error: DatabaseError) =>
	new RecommendationIssuePersistenceError({ message: error.message })

const rowToIssue = (row: IssueRow): RecommendationIssue =>
	new RecommendationIssue({
		id: decodeIssueIdSync(row.id),
		number: row.number,
		recommendationKey: row.recommendationKey,
		kind: decodeKindSync(row.kind),
		sourceKey: row.sourceKey,
		...(row.canonicalKey != null ? { canonicalKey: row.canonicalKey } : {}),
		status: decodeStatusSync(row.status),
		usageCount: row.usageCount,
		openedAt: decodeIsoSync(row.openedAt.toISOString()),
		updatedAt: decodeIsoSync(row.updatedAt.toISOString()),
		...(row.resolvedAt != null ? { resolvedAt: decodeIsoSync(row.resolvedAt.toISOString()) } : {}),
	})

export class RecommendationIssueService extends Context.Service<
	RecommendationIssueService,
	RecommendationIssueServiceShape
>()("@maple/api/services/RecommendationIssueService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const runDb = <A>(
			operation: string,
			effect: Effect.Effect<A, DatabaseError>,
		): Effect.Effect<A, RecommendationIssuePersistenceError> =>
			effect.pipe(
				Effect.tapCause((cause) =>
					Effect.logError("Recommendation issue database operation failed").pipe(
						Effect.annotateLogs({ operation, cause }),
					),
				),
				Effect.mapError(toPersistenceError),
			)

		const selectAll = (orgId: OrgId) =>
			runDb(
				"list",
				database.execute((db) =>
					db
						.select()
						.from(orgRecommendationIssues)
						.where(eq(orgRecommendationIssues.orgId, orgId))
						.orderBy(orgRecommendationIssues.number),
				),
			)

		const listResponse = (orgId: OrgId) =>
			selectAll(orgId).pipe(
				Effect.map((rows) => new RecommendationIssuesListResponse({ issues: rows.map(rowToIssue) })),
			)

		// Reads the org's live span attribute keys (last 24h) from the warehouse.
		const fetchSpanKeys = Effect.fn("RecommendationIssueService.fetchSpanKeys")(function* (
			tenant: TenantContext,
		) {
			const now = yield* Clock.currentTimeMillis
			const compiled = CH.compile(CH.attributeKeysQuery({ scope: "span" }), {
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(now - 24 * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			})
			const rows = yield* warehouse
				.compiledQuery(tenant, compiled, { profile: "discovery", context: "recommendationIssues" })
				.pipe(
					Effect.tapCause((cause) =>
						Effect.logError("Recommendation span-key query failed").pipe(
							Effect.annotateLogs({ cause }),
						),
					),
					Effect.mapError(
						() =>
							new RecommendationIssuePersistenceError({
								message: "Failed to read span attribute keys",
							}),
					),
				)
			return rows.map((row) => ({
				attributeKey: String(row.attributeKey),
				usageCount: Number(row.usageCount),
			}))
		})

		const listReconciled = Effect.fn("RecommendationIssueService.listReconciled")(function* (
			tenant: TenantContext,
		) {
			const orgId = tenant.orgId
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			// Reconcile needs live span keys. If the warehouse is unavailable, degrade gracefully:
			// return the stored issues unchanged rather than failing the whole settings page.
			const spanKeysOpt = yield* fetchSpanKeys(tenant).pipe(Effect.option)
			if (Option.isNone(spanKeysOpt)) {
				yield* Effect.logWarning(
					"Recommendation reconcile skipped — warehouse unavailable; returning stored issues",
				)
				return yield* listResponse(orgId)
			}
			const spanKeys = spanKeysOpt.value

			const mappingRows = yield* runDb(
				"listMappings",
				database.execute((db) =>
					db
						.select({ sourceKey: orgIngestAttributeMappings.sourceKey })
						.from(orgIngestAttributeMappings)
						.where(
							and(
								eq(orgIngestAttributeMappings.orgId, orgId),
								eq(orgIngestAttributeMappings.sourceContext, "span"),
							),
						),
				),
			)
			const mappingSourceKeys = mappingRows.map((row) => row.sourceKey)

			const detected = detectAttributeRecommendations(spanKeys, mappingSourceKeys)
			const existing = yield* selectAll(orgId)
			const existingLike = existing.map((row) => ({
				id: row.id,
				number: row.number,
				recommendationKey: row.recommendationKey,
				sourceKey: row.sourceKey,
				status: decodeStatusSync(row.status),
			}))
			const plan = planReconcileIssues(detected, existingLike, mappingSourceKeys)

			const now = yield* Clock.currentTimeMillis

			if (plan.inserts.length > 0) {
				const rows = plan.inserts.map((insert) => ({
					id: decodeIssueIdSync(randomUUID()),
					orgId,
					number: insert.number,
					recommendationKey: insert.recommendationKey,
					kind: insert.kind,
					sourceKey: insert.sourceKey,
					canonicalKey: insert.canonicalKey,
					status: "open" as const,
					usageCount: insert.usageCount,
					openedAt: new Date(now),
					updatedAt: new Date(now),
					resolvedAt: null,
				}))
				yield* runDb(
					"insert",
					database.execute((db) => db.insert(orgRecommendationIssues).values(rows)),
				)
			}

			yield* Effect.forEach(
				plan.updates,
				(update) => {
					const fields: Record<string, unknown> = { updatedAt: new Date(now) }
					if (update.usageCount !== undefined) fields.usageCount = update.usageCount
					if (update.nextStatus !== undefined) {
						fields.status = update.nextStatus
						fields.resolvedAt = update.nextStatus === "open" ? null : new Date(now)
					}
					return runDb(
						"update",
						database.execute((db) =>
							db
								.update(orgRecommendationIssues)
								.set(fields)
								.where(
									and(
										eq(orgRecommendationIssues.orgId, orgId),
										eq(orgRecommendationIssues.id, update.id),
									),
								),
						),
					)
				},
				{ discard: true },
			)

			return yield* listResponse(orgId)
		})

		const setStatus = Effect.fn("RecommendationIssueService.setStatus")(function* (
			tenant: TenantContext,
			id: RecommendationIssueId,
			fields: Record<string, unknown>,
		) {
			const orgId = tenant.orgId
			yield* Effect.annotateCurrentSpan({ orgId, "maple.recommendation_issue.id": id })
			const existing = yield* runDb(
				"selectById",
				database.execute((db) =>
					db
						.select({ id: orgRecommendationIssues.id })
						.from(orgRecommendationIssues)
						.where(
							and(eq(orgRecommendationIssues.orgId, orgId), eq(orgRecommendationIssues.id, id)),
						)
						.limit(1),
				),
			)
			if (Option.isNone(Option.fromNullishOr(existing[0]))) {
				yield* Effect.logWarning("Recommendation issue not found").pipe(
					Effect.annotateLogs({ issueId: id, orgId }),
				)
				return yield* new RecommendationIssueNotFoundError({
					id,
					message: "Recommendation not found",
				})
			}

			const now = yield* Clock.currentTimeMillis
			yield* runDb(
				"setStatus",
				database.execute((db) =>
					db
						.update(orgRecommendationIssues)
						.set({ ...fields, updatedAt: new Date(now) })
						.where(
							and(eq(orgRecommendationIssues.orgId, orgId), eq(orgRecommendationIssues.id, id)),
						),
				),
			)
			return yield* listResponse(orgId)
		})

		const dismiss = (tenant: TenantContext, id: RecommendationIssueId) =>
			setStatus(tenant, id, { status: "dismissed" })

		const reopen = (tenant: TenantContext, id: RecommendationIssueId) =>
			setStatus(tenant, id, { status: "open", resolvedAt: null })

		return { listReconciled, dismiss, reopen } satisfies RecommendationIssueServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
