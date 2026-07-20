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
import type { RoleName as RoleNameType } from "@maple/domain/http"
import { createClerkClient } from "@clerk/backend"
import { render } from "@react-email/components"
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { Clock, Array as Arr, Cause, Effect, Layer, Option, Redacted, Ref, Context } from "effect"
import { deriveDigestStatus, WeeklyDigest, type WeeklyDigestProps } from "@maple/email/weekly-digest"
import { Database } from "../lib/DatabaseLive"
import { dateToMs } from "../lib/time"
import { EmailService } from "../lib/EmailService"
import { Env } from "../lib/Env"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { EdgeCacheService } from "@maple/query-engine/caching"
import {
	isOrgWarehouseQuarantined,
	quarantineOnConfigClassCause,
} from "../lib/warehouse-org-quarantine"

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
	fingerprintHash: string
	errorLabel: string
	sampleMessage: string
	count: number
	affectedServicesCount: number
	firstSeen: string
	lastSeen: string
}

interface TracesTimeseriesRow {
	bucket: string
	count: number
	errorRate: number
}

export class DigestService extends Context.Service<DigestService>()("@maple/api/services/DigestService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const email = yield* EmailService
		const env = yield* Env
		const warehouse = yield* WarehouseQueryService
		const edgeCache = yield* EdgeCacheService

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

			const now = yield* Clock.currentTimeMillis
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
							enabled: input.enabled !== false,
							dayOfWeek: input.dayOfWeek ?? 1,
							timezone: input.timezone ?? "UTC",
							createdAt: new Date(now),
							updatedAt: new Date(now),
						})
						.onConflictDoUpdate({
							target: [digestSubscriptions.orgId, digestSubscriptions.userId],
							set: {
								email: input.email,
								enabled: input.enabled !== false,
								...(input.dayOfWeek != null ? { dayOfWeek: input.dayOfWeek } : {}),
								...(input.timezone != null ? { timezone: input.timezone } : {}),
								updatedAt: new Date(now),
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

		/**
		 * Resolve a human-friendly org name via Clerk. Best-effort: a digest
		 * must never fail because a name lookup did — falls back to the raw
		 * orgId on any error or when Clerk isn't configured.
		 */
		const resolveOrgName = Effect.fn("DigestService.resolveOrgName")(function* (orgId: OrgId) {
			if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return String(orgId)
			if (Option.isNone(env.CLERK_SECRET_KEY)) return String(orgId)

			const clerk = createClerkClient({
				secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
			})

			return yield* Effect.tryPromise({
				try: () => clerk.organizations.getOrganization({ organizationId: orgId }),
				catch: (error) => error,
			}).pipe(
				Effect.map((org) => org.name || String(orgId)),
				Effect.orElseSucceed(() => String(orgId)),
			)
		})

		const generateDigestData = Effect.fn("DigestService.generateDigestData")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			const now = new Date(yield* Clock.currentTimeMillis)
			const toClickHouseDateTime = (d: Date) =>
				d
					.toISOString()
					.replace("T", " ")
					.replace(/\.\d{3}Z$/, "")
			const currentEnd = toClickHouseDateTime(now)
			const currentStart = toClickHouseDateTime(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))
			const previousStart = toClickHouseDateTime(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000))

			// Sparkline window: 7 *complete* UTC days. `bucket_seconds: 86_400`
			// snaps `toStartOfInterval` to UTC midnight, so a rolling now-7d
			// window would split into 8 partial-day buckets (a duplicated
			// weekday at the seam). Day-aligning the window keeps it to exactly 7.
			const DAY_MS = 24 * 60 * 60 * 1000
			const todayStartMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS
			const seriesStart = toClickHouseDateTime(new Date(todayStartMs - 7 * DAY_MS))
			const seriesEnd = toClickHouseDateTime(new Date(todayStartMs - 1000))

			const systemTenant = {
				orgId,
				userId: SYSTEM_DIGEST_USER,
				roles: [ROOT_ROLE] as ReadonlyArray<RoleNameType>,
				authMode: "self_hosted" as const,
			}

			// Query all data in parallel. service_overview and get_service_usage
			// use the *_compare pipes which UNION ALL current + previous windows
			// into a single Tinybird query, tagging rows with a `period` column.
			// The daily timeseries drives the trend sparkline; the previous-week
			// errors give us a fingerprint set so we can flag genuinely NEW errors.
			const [overviewResponse, usageResponse, seriesResponse, topErrors, prevErrorsResponse] =
				yield* Effect.all(
					[
						warehouse.query(systemTenant, {
							pipeName: "service_overview_compare",
							params: {
								current_start_time: currentStart,
								current_end_time: currentEnd,
								previous_start_time: previousStart,
								previous_end_time: currentStart,
							},
						}),
						warehouse.query(systemTenant, {
							pipeName: "get_service_usage_compare",
							params: {
								current_start_time: currentStart,
								current_end_time: currentEnd,
								previous_start_time: previousStart,
								previous_end_time: currentStart,
							},
						}),
						warehouse.query(systemTenant, {
							pipeName: "custom_traces_timeseries",
							params: {
								start_time: seriesStart,
								end_time: seriesEnd,
								bucket_seconds: 86_400,
							},
						}),
						warehouse.query(systemTenant, {
							pipeName: "errors_by_type",
							params: {
								start_time: currentStart,
								end_time: currentEnd,
								limit: 5,
							},
						}),
						warehouse.query(systemTenant, {
							pipeName: "errors_by_type",
							params: {
								start_time: previousStart,
								end_time: currentStart,
								limit: 100,
							},
						}),
					],
					{ concurrency: 5 },
				).pipe(
				Effect.mapError(
					(error) =>
						new DigestPersistenceError({
							message: `Failed to fetch digest data from Tinybird: ${error instanceof Error ? error.message : String(error)}`,
						}),
				),
			)

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

			// Per-service WoW deltas: match current rows against the previous window.
			const prevThroughputByService = new Map<string, number>()
			for (const s of prevOverviewData) {
				prevThroughputByService.set(String(s.serviceName), Number(s.throughput) || 0)
			}

			const services = curOverviewData
				.slice()
				.sort((a, b) => (Number(b.throughput) || 0) - (Number(a.throughput) || 0))
				.slice(0, 10)
				.map((s) => {
					const requests = Number(s.throughput) || 0
					return {
						name: String(s.serviceName),
						requests,
						errorRate: requests > 0 ? ((Number(s.errorCount) || 0) / requests) * 100 : 0,
						p95Ms: Number(s.p95LatencyMs) || 0,
						requestsDelta: delta(requests, prevThroughputByService.get(String(s.serviceName)) ?? 0),
					}
				})
				// Float the unhealthiest services to the top so problems surface
				// first. Array.sort is stable, so ties keep their throughput order.
				.sort((a, b) => b.errorRate - a.errorRate)

			// Flag errors absent from the previous week's top fingerprints as NEW.
			const prevErrorFingerprints = new Set(
				(prevErrorsResponse.data as Array<ErrorsByTypeRow>).map((e) => String(e.fingerprintHash)),
			)
			const errorsData = (topErrors.data as Array<ErrorsByTypeRow>).slice(0, 5).map((e) => ({
				message: String(e.errorLabel || e.sampleMessage || "Unknown error"),
				count: Number(e.count) || 0,
				affectedServices: Number(e.affectedServicesCount) || 0,
				isNew: e.fingerprintHash ? !prevErrorFingerprints.has(String(e.fingerprintHash)) : false,
			}))

			// Daily request/error buckets (one row per UTC day) for the sparkline.
			const weekdayInitial = (bucket: string) => {
				const d = new Date(`${String(bucket).slice(0, 10)}T00:00:00Z`)
				return Number.isNaN(d.getTime()) ? "" : ["S", "M", "T", "W", "T", "F", "S"][d.getUTCDay()]
			}
			const series = (seriesResponse.data as Array<TracesTimeseriesRow>)
				.slice()
				.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
				// Guard against any boundary off-by-one — keep the 7 most recent days.
				.slice(-7)
				.map((r) => {
					const requests = Number(r.count) || 0
					return {
						label: weekdayInitial(r.bucket),
						requests,
						errors: Math.round(requests * (Number(r.errorRate) || 0)),
					}
				})

			const orgName = yield* resolveOrgName(orgId)
			const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

			const props: WeeklyDigestProps = {
				orgName,
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
				series,
				services,
				topErrors: errorsData,
				ingestion: curUsage,
				baseUrl: env.MAPLE_APP_BASE_URL,
				dashboardUrl: `${env.MAPLE_APP_BASE_URL}`,
				unsubscribeUrl: `${env.MAPLE_APP_BASE_URL}/settings/notifications`,
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
		const lastSyncAt = yield* Ref.make<number | null>(null)

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

				// Genuine cursor pagination: each page advances `offset` by the
				// number of rows it returned, and the terminating condition depends
				// on the just-fetched page (totalCount / empty page). Effect v4
				// (beta) ships neither `iterate` nor `loop`, so an imperative
				// while-loop driving sequential `yield*`s is the clearest form here.
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

			const perOrgMemberships = yield* Effect.forEach(orgs, (org) =>
				Effect.gen(function* () {
					const members = yield* paginateClerk(
						(params) =>
							clerk.organizations.getOrganizationMembershipList({
								organizationId: org.id,
								...params,
							}),
						`Failed to list Clerk members for org ${org.id}`,
					)

					return members.flatMap((member) => {
						const memberEmail = member.publicUserData?.identifier
						const memberUserId = member.publicUserData?.userId
						if (!memberEmail || !memberUserId) return []
						return [{ orgId: org.id, userId: memberUserId, email: memberEmail }]
					})
				}),
			)

			return perOrgMemberships.flat()
		})

		const reconcileSubscriptions = Effect.fn("DigestService.reconcileSubscriptions")(function* (
			clerkMemberships: Array<{ orgId: string; userId: string; email: string }>,
		) {
			const now = yield* Clock.currentTimeMillis

			// Upsert all current Clerk members (re-enables returning members, updates email)
			yield* Effect.forEach(
				clerkMemberships,
				(m) =>
					database
						.execute((db) =>
							db
								.insert(digestSubscriptions)
								.values({
									id: crypto.randomUUID(),
									orgId: m.orgId,
									userId: m.userId,
									email: m.email,
									enabled: true,
									dayOfWeek: 1,
									timezone: "UTC",
									createdAt: new Date(now),
									updatedAt: new Date(now),
								})
								.onConflictDoUpdate({
									target: [digestSubscriptions.orgId, digestSubscriptions.userId],
									set: {
										email: m.email,
										enabled: true,
										updatedAt: new Date(now),
									},
								}),
						)
						.pipe(Effect.mapError(toPersistenceError)),
				{ discard: true },
			)

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
									.set({ enabled: false, updatedAt: new Date(now) })
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
			const now = yield* Clock.currentTimeMillis
			const lastSync = yield* Ref.get(lastSyncAt)
			if (lastSync != null && now - lastSync < SYNC_INTERVAL_MS) return

			const clerk = createClerkClient({
				secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
			})

			const memberships = yield* fetchAllClerkMemberships(clerk)
			yield* reconcileSubscriptions(memberships)

			yield* Ref.set(lastSyncAt, now)

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

			const now = yield* Clock.currentTimeMillis
			const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
			const todayStartMs = now - (now % 86_400_000)
			const currentDayOfWeek = new Date(now).getUTCDay()

			// Find subscriptions due for sending
			const subs = yield* database
				.execute((db) =>
					db.select().from(digestSubscriptions).where(eq(digestSubscriptions.enabled, true)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const dueSubs = subs.filter(
				(s) =>
					s.dayOfWeek === currentDayOfWeek &&
					(s.lastSentAt == null || s.lastSentAt.getTime() < sevenDaysAgo),
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

						// Orgs whose warehouse rejected queries with an auth/config-class
						// error are parked (see warehouse-org-quarantine.ts). Checked before
						// the claim so a parked org isn't marked attempted for the day.
						if (yield* isOrgWarehouseQuarantined(edgeCache, rawOrgId)) {
							yield* Effect.logInfo("Skipping digest for org with quarantined warehouse").pipe(
								Effect.annotateLogs({ orgId: rawOrgId }),
							)
							return []
						}

						const claim = yield* database
							.execute((db) =>
								db
									.update(digestSubscriptions)
									.set({ lastAttemptedAt: new Date(now) })
									.where(
										and(
											inArray(digestSubscriptions.id, orgSubIds),
											or(
												isNull(digestSubscriptions.lastAttemptedAt),
												lt(digestSubscriptions.lastAttemptedAt, new Date(todayStartMs)),
											),
										),
									)
									.returning({ id: digestSubscriptions.id }),
							)
							.pipe(Effect.mapError(toPersistenceError))

						if (claim.length === 0) {
							yield* Effect.logInfo("Skipping digest org already attempted today").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									subscriptionCount: orgSubs.length,
								}),
							)
							return []
						}

						const claimedIds = new Set(claim.map((c) => c.id))
						const claimedSubs = orgSubs.filter((s) => claimedIds.has(s.id))

						if (claimedSubs.length < orgSubs.length) {
							yield* Effect.logInfo("Skipping digest subscriptions already attempted today").pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									skippedCount: orgSubs.length - claimedSubs.length,
									claimedCount: claimedSubs.length,
								}),
							)
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
						const subject = deriveDigestStatus(props).subject

						const sendResults = yield* Effect.forEach(
							claimedSubs,
							(sub) =>
								email.send(sub.email, subject, html).pipe(
									Effect.tap(() =>
										Effect.gen(function* () {
											const lastSentAt = yield* Clock.currentTimeMillis
											yield* database.execute((db) =>
												db
													.update(digestSubscriptions)
													.set({ lastSentAt: new Date(lastSentAt) })
													.where(eq(digestSubscriptions.id, sub.id)),
											)
										}).pipe(
											// The email is already sent — a failed bookkeeping write must
											// not surface as a send failure (lastAttemptedAt still blocks
											// same-day retries).
											Effect.catchCause((cause) =>
												Effect.logWarning("Failed to record digest lastSentAt").pipe(
													Effect.annotateLogs({
														subscriptionId: sub.id,
														orgId: rawOrgId,
														error: Cause.pretty(cause),
													}),
												),
											),
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
							Effect.gen(function* () {
								const quarantined = yield* quarantineOnConfigClassCause(
									edgeCache,
									rawOrgId,
									cause,
									now,
								)
								if (quarantined) {
									yield* Effect.logInfo(
										"Org warehouse rejected queries with a config-class error; quarantined",
									).pipe(Effect.annotateLogs({ orgId: rawOrgId, error: Cause.pretty(cause) }))
								} else {
									yield* Effect.logError("Digest failed for org").pipe(
										Effect.annotateLogs({
											orgId: rawOrgId,
											error: Cause.pretty(cause),
										}),
									)
								}
								return orgSubs.map(() => ({ sent: false }))
							}),
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
	static readonly layer = Layer.effect(this, this.make)
}

function rowToResponse(row: typeof digestSubscriptions.$inferSelect): DigestSubscriptionResponse {
	return new DigestSubscriptionResponse({
		id: DigestSubscriptionId.make(row.id),
		email: row.email,
		enabled: row.enabled,
		dayOfWeek: row.dayOfWeek,
		timezone: row.timezone,
		lastSentAt: dateToMs(row.lastSentAt),
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
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
