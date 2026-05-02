import { digestSubscriptions } from "@maple/db"
import {
	DigestNotConfiguredError,
	DigestNotFoundError,
	DigestPersistenceError,
	DigestPreviewResponse,
	DigestRenderError,
	DigestSubscriptionId,
	DigestSubscriptionResponse,
	OrgId,
	UserId,
	RoleName,
} from "@maple/domain/http"
import type { OrgId as OrgIdType, RoleName as RoleNameType } from "@maple/domain/http"
import { createClerkClient } from "@clerk/backend"
import { render } from "@react-email/components"
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { Array as Arr, Cause, Effect, Layer, Option, Redacted, Context } from "effect"
import { WeeklyDigest, type WeeklyDigestProps } from "@maple/email/weekly-digest"
import { Database } from "./DatabaseLive"
import { EmailService } from "./EmailService"
import { Env } from "./Env"
import { WarehouseQueryService } from "./WarehouseQueryService"

const SYSTEM_DIGEST_USER = UserId.make("system-digest")
const ROOT_ROLE = RoleName.make("root")
const D1_INARRAY_CHUNK_SIZE = 90

const toPersistenceError = (error: unknown) =>
	new DigestPersistenceError({
		message: error instanceof Error ? `${error.message}` : `Digest persistence error: ${String(error)}`,
	})

/** Row shapes matching query engine output (camelCase from CH DSL) */
interface ServiceOverviewRow {
	serviceName: string
	throughput: number
	errorCount: number
	p95LatencyMs: number
}

interface ServiceOverviewCompareRow extends ServiceOverviewRow {
	period: "current" | "previous"
}

interface ServiceUsageRow {
	serviceName: string
	totalLogCount: number
	totalLogSizeBytes: number
	totalTraceCount: number
	totalTraceSizeBytes: number
	totalSumMetricCount: number
	totalSumMetricSizeBytes: number
	totalGaugeMetricCount: number
	totalGaugeMetricSizeBytes: number
	totalHistogramMetricCount: number
	totalHistogramMetricSizeBytes: number
	totalExpHistogramMetricCount: number
	totalExpHistogramMetricSizeBytes: number
	totalSizeBytes: number
}

interface ServiceUsageCompareRow extends ServiceUsageRow {
	period: "current" | "previous"
}

interface ErrorsByTypeRow {
	errorType: string
	sampleMessage: string
	count: number
}

export class DigestService extends Context.Service<DigestService>()("DigestService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const email = yield* EmailService
		const env = yield* Env
		const warehouse = yield* WarehouseQueryService

		const getSubscription = Effect.fn("DigestService.getSubscription")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)

			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(digestSubscriptions)
						.where(
							and(eq(digestSubscriptions.orgId, orgId), eq(digestSubscriptions.userId, userId)),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = rows[0]
			if (!row) {
				return yield* new DigestNotFoundError({
					message: "No digest subscription found",
				})
			}

			return rowToResponse(row)
		})

		const upsertSubscription = Effect.fn("DigestService.upsertSubscription")(function* (
			orgId: OrgId,
			userId: UserId,
			input: {
				email: string
				enabled?: boolean
				dayOfWeek?: number
				timezone?: string
			},
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)

			const now = Date.now()
			const id = crypto.randomUUID()

			yield* database
				.execute((db) =>
					db
						.insert(digestSubscriptions)
						.values({
							id,
							orgId,
							userId,
							email: input.email,
							enabled: input.enabled === false ? 0 : 1,
							dayOfWeek: input.dayOfWeek ?? 1,
							timezone: input.timezone ?? "UTC",
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [digestSubscriptions.orgId, digestSubscriptions.userId],
							set: {
								email: input.email,
								enabled: input.enabled === false ? 0 : 1,
								...(input.dayOfWeek != null ? { dayOfWeek: input.dayOfWeek } : {}),
								...(input.timezone != null ? { timezone: input.timezone } : {}),
								updatedAt: now,
							},
						}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return yield* getSubscription(orgId, userId)
		})

		const deleteSubscription = Effect.fn("DigestService.deleteSubscription")(function* (
			orgId: OrgId,
			userId: UserId,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("userId", userId)

			yield* database
				.execute((db) =>
					db
						.delete(digestSubscriptions)
						.where(
							and(eq(digestSubscriptions.orgId, orgId), eq(digestSubscriptions.userId, userId)),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))
		})

		const generateDigestData = Effect.fn("DigestService.generateDigestData")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			const now = new Date()
			const toClickHouseDateTime = (d: Date) =>
				d
					.toISOString()
					.replace("T", " ")
					.replace(/\.\d{3}Z$/, "")
			const currentEnd = toClickHouseDateTime(now)
			const currentStart = toClickHouseDateTime(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))
			const previousStart = toClickHouseDateTime(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000))

			const systemTenant = {
				orgId,
				userId: SYSTEM_DIGEST_USER,
				roles: [ROOT_ROLE] as ReadonlyArray<RoleNameType>,
				authMode: "self_hosted" as const,
			}

			// Query all data in parallel. service_overview and get_service_usage
			// use the *_compare pipes which UNION ALL current + previous windows
			// into a single Tinybird query, tagging rows with a `period` column.
			const [overviewResponse, currentErrors, usageResponse, topErrors] = yield* Effect.all(
				[
					warehouse.query(systemTenant, {
						pipe: "service_overview_compare",
						params: {
							current_start_time: currentStart,
							current_end_time: currentEnd,
							previous_start_time: previousStart,
							previous_end_time: currentStart,
						},
					}),
					warehouse.query(systemTenant, {
						pipe: "errors_summary",
						params: { start_time: currentStart, end_time: currentEnd },
					}),
					warehouse.query(systemTenant, {
						pipe: "get_service_usage_compare",
						params: {
							current_start_time: currentStart,
							current_end_time: currentEnd,
							previous_start_time: previousStart,
							previous_end_time: currentStart,
						},
					}),
					warehouse.query(systemTenant, {
						pipe: "errors_by_type",
						params: {
							start_time: currentStart,
							end_time: currentEnd,
							limit: 5,
						},
					}),
				],
				{ concurrency: 4 },
			).pipe(
				Effect.mapError(
					(error) =>
						new DigestPersistenceError({
							message: `Failed to fetch digest data from Tinybird: ${error instanceof Error ? error.message : String(error)}`,
						}),
				),
			)

			void currentErrors

			// Split UNION ALL'd rows by period discriminator
			const overviewRows = overviewResponse.data as Array<ServiceOverviewCompareRow>
			const curOverviewData: Array<ServiceOverviewRow> = overviewRows.filter(
				(r) => r.period === "current",
			)
			const prevOverviewData: Array<ServiceOverviewRow> = overviewRows.filter(
				(r) => r.period === "previous",
			)

			const totalRequests = curOverviewData.reduce((sum, s) => sum + (Number(s.throughput) || 0), 0)
			const prevTotalRequests = prevOverviewData.reduce(
				(sum, s) => sum + (Number(s.throughput) || 0),
				0,
			)

			const totalErrors = curOverviewData.reduce((sum, s) => sum + (Number(s.errorCount) || 0), 0)
			const prevTotalErrors = prevOverviewData.reduce((sum, s) => sum + (Number(s.errorCount) || 0), 0)

			// Weighted avg P95
			const avgP95 =
				totalRequests > 0
					? curOverviewData.reduce(
							(sum, s) => sum + (Number(s.p95LatencyMs) || 0) * (Number(s.throughput) || 0),
							0,
						) / totalRequests
					: 0
			const prevAvgP95 =
				prevTotalRequests > 0
					? prevOverviewData.reduce(
							(sum, s) => sum + (Number(s.p95LatencyMs) || 0) * (Number(s.throughput) || 0),
							0,
						) / prevTotalRequests
					: 0

			// Data volume — split UNION ALL'd rows by period discriminator
			const usageRows = usageResponse.data as Array<ServiceUsageCompareRow>
			const curUsageData: Array<ServiceUsageRow> = usageRows.filter((r) => r.period === "current")
			const prevUsageData: Array<ServiceUsageRow> = usageRows.filter((r) => r.period === "previous")
			const sumUsage = (data: Array<ServiceUsageRow>) => ({
				logs: data.reduce((s, r) => s + (Number(r.totalLogCount) || 0), 0),
				traces: data.reduce((s, r) => s + (Number(r.totalTraceCount) || 0), 0),
				metrics: data.reduce(
					(s, r) =>
						s +
						(Number(r.totalSumMetricCount) || 0) +
						(Number(r.totalGaugeMetricCount) || 0) +
						(Number(r.totalHistogramMetricCount) || 0) +
						(Number(r.totalExpHistogramMetricCount) || 0),
					0,
				),
				totalBytes: data.reduce(
					(s, r) =>
						s +
						(Number(r.totalLogSizeBytes) || 0) +
						(Number(r.totalTraceSizeBytes) || 0) +
						(Number(r.totalSumMetricSizeBytes) || 0) +
						(Number(r.totalGaugeMetricSizeBytes) || 0) +
						(Number(r.totalHistogramMetricSizeBytes) || 0) +
						(Number(r.totalExpHistogramMetricSizeBytes) || 0),
					0,
				),
			})
			const curUsage = sumUsage(curUsageData)
			const prevUsage = sumUsage(prevUsageData)

			const delta = (cur: number, prev: number) =>
				prev === 0 ? (cur > 0 ? 100 : 0) : ((cur - prev) / prev) * 100

			const formatDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

			const services = curOverviewData
				.sort((a, b) => (Number(b.throughput) || 0) - (Number(a.throughput) || 0))
				.slice(0, 10)
				.map((s) => ({
					name: String(s.serviceName),
					requests: Number(s.throughput) || 0,
					errorRate:
						(Number(s.throughput) || 0) > 0
							? ((Number(s.errorCount) || 0) / (Number(s.throughput) || 0)) * 100
							: 0,
					p95Ms: Number(s.p95LatencyMs) || 0,
				}))

			const errorsData = (topErrors.data as Array<ErrorsByTypeRow>).slice(0, 5).map((e) => ({
				message: String(e.errorType || e.sampleMessage || "Unknown"),
				count: Number(e.count) || 0,
			}))

			const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

			const props: WeeklyDigestProps = {
				orgName: orgId,
				dateRange: {
					start: formatDate(startDate),
					end: formatDate(now),
				},
				summary: {
					requests: {
						value: totalRequests,
						delta: delta(totalRequests, prevTotalRequests),
					},
					errors: {
						value: totalErrors,
						delta: delta(totalErrors, prevTotalErrors),
					},
					p95Latency: {
						valueMs: avgP95,
						delta: delta(avgP95, prevAvgP95),
					},
					dataVolume: {
						valueBytes: curUsage.totalBytes,
						delta: delta(curUsage.totalBytes, prevUsage.totalBytes),
					},
				},
				services,
				topErrors: errorsData,
				ingestion: curUsage,
				dashboardUrl: `${env.MAPLE_APP_BASE_URL}`,
				unsubscribeUrl: `${env.MAPLE_APP_BASE_URL}/settings`,
			}

			yield* Effect.annotateCurrentSpan("totalRequests", totalRequests)
			yield* Effect.annotateCurrentSpan("totalErrors", totalErrors)
			yield* Effect.annotateCurrentSpan("serviceCount", services.length)
			yield* Effect.logInfo("Digest data generated").pipe(
				Effect.annotateLogs({
					orgId,
					totalRequests,
					totalErrors,
					serviceCount: services.length,
				}),
			)

			return props
		})

		const renderDigestHtml = Effect.fn("DigestService.renderDigestHtml")(function* (
			props: WeeklyDigestProps,
		) {
			return yield* Effect.tryPromise({
				try: () => render(WeeklyDigest(props)),
				catch: (error) =>
					new DigestRenderError({
						message: error instanceof Error ? error.message : "Failed to render digest email",
					}),
			})
		})

		const preview = Effect.fn("DigestService.preview")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			if (!email.isConfigured) {
				return yield* new DigestNotConfiguredError({
					message: "Email delivery is not configured",
				})
			}

			const props = yield* generateDigestData(orgId)
			const html = yield* renderDigestHtml(props)
			return new DigestPreviewResponse({ html })
		})

		const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
		let lastSyncAt: number | null = null

		const paginateClerk = <T>(
			fetchPage: (params: {
				limit: number
				offset: number
			}) => Promise<{ data: T[]; totalCount: number }>,
			errorMessage: string,
		) =>
			Effect.gen(function* () {
				const PAGE_SIZE = 100
				let offset = 0
				const all: T[] = []

				while (true) {
					const page = yield* Effect.tryPromise({
						try: () => fetchPage({ limit: PAGE_SIZE, offset }),
						catch: () => new DigestPersistenceError({ message: errorMessage }),
					})
					all.push(...page.data)
					offset += page.data.length
					if (offset >= page.totalCount || page.data.length === 0) break
				}

				return all
			})

		const fetchAllClerkMemberships = Effect.fn("DigestService.fetchAllClerkMemberships")(function* (
			clerk: ReturnType<typeof createClerkClient>,
		) {
			const orgs = yield* paginateClerk(
				(params) => clerk.organizations.getOrganizationList(params),
				"Failed to list Clerk organizations",
			)

			const memberships: Array<{ orgId: string; userId: string; email: string }> = []

			for (const org of orgs) {
				const members = yield* paginateClerk(
					(params) =>
						clerk.organizations.getOrganizationMembershipList({
							organizationId: org.id,
							...params,
						}),
					`Failed to list Clerk members for org ${org.id}`,
				)

				for (const member of members) {
					const memberEmail = member.publicUserData?.identifier
					const memberUserId = member.publicUserData?.userId
					if (!memberEmail || !memberUserId) continue
					memberships.push({ orgId: org.id, userId: memberUserId, email: memberEmail })
				}
			}

			return memberships
		})

		const reconcileSubscriptions = Effect.fn("DigestService.reconcileSubscriptions")(function* (
			clerkMemberships: Array<{ orgId: string; userId: string; email: string }>,
		) {
			const now = Date.now()

			// Upsert all current Clerk members (re-enables returning members, updates email)
			for (const m of clerkMemberships) {
				yield* database
					.execute((db) =>
						db
							.insert(digestSubscriptions)
							.values({
								id: crypto.randomUUID(),
								orgId: m.orgId,
								userId: m.userId,
								email: m.email,
								enabled: 1,
								dayOfWeek: 1,
								timezone: "UTC",
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoUpdate({
								target: [digestSubscriptions.orgId, digestSubscriptions.userId],
								set: {
									email: m.email,
									enabled: 1,
									updatedAt: now,
								},
							}),
					)
					.pipe(Effect.mapError(toPersistenceError))
			}

			// Disable subscriptions for members no longer in any Clerk org
			const activeOrgIds = [...new Set(clerkMemberships.map((m) => m.orgId))]
			if (activeOrgIds.length === 0) return

			// D1 caps SQLite bind variables at ~100, so chunk inArray queries.
			const existingSubs = yield* Effect.forEach(
				Arr.chunksOf(activeOrgIds, D1_INARRAY_CHUNK_SIZE),
				(chunk) =>
					database
						.execute((db) =>
							db
								.select({
									id: digestSubscriptions.id,
									orgId: digestSubscriptions.orgId,
									userId: digestSubscriptions.userId,
								})
								.from(digestSubscriptions)
								.where(inArray(digestSubscriptions.orgId, chunk)),
						)
						.pipe(Effect.mapError(toPersistenceError)),
			).pipe(Effect.map(Arr.flatten))

			const activeKeys = new Set(clerkMemberships.map((m) => `${m.orgId}:${m.userId}`))
			const staleIds = existingSubs
				.filter((s) => !activeKeys.has(`${s.orgId}:${s.userId}`))
				.map((s) => s.id)

			if (staleIds.length > 0) {
				yield* Effect.forEach(
					Arr.chunksOf(staleIds, D1_INARRAY_CHUNK_SIZE),
					(chunk) =>
						database
							.execute((db) =>
								db
									.update(digestSubscriptions)
									.set({ enabled: 0, updatedAt: now })
									.where(inArray(digestSubscriptions.id, chunk)),
							)
							.pipe(Effect.mapError(toPersistenceError)),
					{ discard: true },
				)

				yield* Effect.logInfo("Disabled stale digest subscriptions").pipe(
					Effect.annotateLogs({ count: staleIds.length }),
				)
			}
		})

		const ensureSubscriptions = Effect.fn("DigestService.ensureSubscriptions")(function* () {
			if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return
			if (Option.isNone(env.CLERK_SECRET_KEY)) return

			// Rate-limit: only sync from Clerk once per 24 hours
			const now = Date.now()
			if (lastSyncAt != null && now - lastSyncAt < SYNC_INTERVAL_MS) return

			const clerk = createClerkClient({
				secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
			})

			const memberships = yield* fetchAllClerkMemberships(clerk)
			yield* reconcileSubscriptions(memberships)

			lastSyncAt = now

			yield* Effect.logInfo("Digest subscriptions synced from Clerk").pipe(
				Effect.annotateLogs({ memberCount: memberships.length }),
			)
		})

		const runDigestTick = Effect.fn("DigestService.runDigestTick")(function* () {
			if (!email.isConfigured) {
				return { sentCount: 0, errorCount: 0, skipped: true }
			}

			yield* ensureSubscriptions().pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Failed to seed digest subscriptions").pipe(
						Effect.annotateLogs({ error: Cause.pretty(cause) }),
					),
				),
			)

			const now = Date.now()
			const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
			const todayStartMs = now - (now % 86_400_000)
			const currentDayOfWeek = new Date().getUTCDay()

			// Find subscriptions due for sending
			const subs = yield* database
				.execute((db) =>
					db.select().from(digestSubscriptions).where(eq(digestSubscriptions.enabled, 1)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const dueSubs = subs.filter(
				(s) =>
					s.dayOfWeek === currentDayOfWeek && (s.lastSentAt == null || s.lastSentAt < sevenDaysAgo),
			)

			if (dueSubs.length === 0) {
				return { sentCount: 0, errorCount: 0, skipped: false }
			}

			// Group by org to avoid duplicate Tinybird queries
			const byOrg = Arr.groupBy(dueSubs, (s) => s.orgId)

			const results = yield* Effect.forEach(
				Object.entries(byOrg),
				([rawOrgId, orgSubs]) =>
					Effect.gen(function* () {
						const orgId = OrgId.make(rawOrgId)
						const orgSubIds = orgSubs.map((s) => s.id)

						const claim = yield* database
							.execute((db) =>
								db
									.update(digestSubscriptions)
									.set({ lastAttemptedAt: now })
									.where(
										and(
											inArray(digestSubscriptions.id, orgSubIds),
											or(
												isNull(digestSubscriptions.lastAttemptedAt),
												lt(digestSubscriptions.lastAttemptedAt, todayStartMs),
											),
										),
									),
							)
							.pipe(Effect.mapError(toPersistenceError))

						if (claim.rowsAffected === 0) {
							yield* Effect.logInfo("Skipping digest org already attempted today").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									subscriptionCount: orgSubs.length,
								}),
							)
							return []
						}

						const props = yield* generateDigestData(orgId)
						if (!hasDigestContent(props)) {
							yield* Effect.logInfo("Skipping digest for org with no data").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									subscriptionCount: orgSubs.length,
								}),
							)

							return []
						}
						const html = yield* renderDigestHtml(props)

						const sendResults = yield* Effect.forEach(
							orgSubs,
							(sub) =>
								email
									.send(
										sub.email,
										`Maple Weekly Digest — ${props.dateRange.start} to ${props.dateRange.end}`,
										html,
									)
									.pipe(
										Effect.tap(() =>
											database.execute((db) =>
												db
													.update(digestSubscriptions)
													.set({ lastSentAt: Date.now() })
													.where(eq(digestSubscriptions.id, sub.id)),
											),
										),
										Effect.match({
											onSuccess: () => ({ sent: true }),
											onFailure: () => ({ sent: false }),
										}),
									),
							{ concurrency: 1 },
						)

						return sendResults
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Digest failed for org").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									error: Cause.pretty(cause),
								}),
								Effect.map(() => orgSubs.map(() => ({ sent: false }))),
							),
						),
					),
				{ concurrency: 1 },
			)

			const allResults = results.flat()
			const sentCount = allResults.filter((r) => r.sent).length
			const errorCount = allResults.filter((r) => !r.sent).length

			yield* Effect.annotateCurrentSpan("sentCount", sentCount)
			yield* Effect.annotateCurrentSpan("errorCount", errorCount)
			yield* Effect.annotateCurrentSpan("orgCount", Object.keys(byOrg).length)

			return { sentCount, errorCount, skipped: false }
		})

		return {
			getSubscription,
			upsertSubscription,
			deleteSubscription,
			preview,
			runDigestTick,
		}
	}),
}) {
	static readonly Default = Layer.effect(this, this.make)
}

function rowToResponse(row: typeof digestSubscriptions.$inferSelect): DigestSubscriptionResponse {
	return new DigestSubscriptionResponse({
		id: DigestSubscriptionId.make(row.id),
		email: row.email,
		enabled: row.enabled === 1,
		dayOfWeek: row.dayOfWeek,
		timezone: row.timezone,
		lastSentAt: row.lastSentAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})
}

function hasDigestContent(props: WeeklyDigestProps): boolean {
	return (
		props.summary.requests.value > 0 ||
		props.summary.errors.value > 0 ||
		props.summary.dataVolume.valueBytes > 0 ||
		props.ingestion.logs > 0 ||
		props.ingestion.traces > 0 ||
		props.ingestion.metrics > 0 ||
		props.ingestion.totalBytes > 0 ||
		props.services.some(
			(service) => service.requests > 0 || service.errorRate > 0 || service.p95Ms > 0,
		) ||
		props.topErrors.some((error) => error.count > 0)
	)
}
