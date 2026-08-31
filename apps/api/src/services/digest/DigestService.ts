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
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { Clock, Array as Arr, Cause, Effect, Layer, Option, Redacted, Ref, Context } from "effect"
import {
	computeDelta,
	deriveDigestStatus,
	type DigestBreakdownRow,
	type DigestEnvironmentGroup,
	type DigestScope,
	type DigestService as DigestServiceRow,
	type WeeklyDigestProps,
} from "@maple/email/weekly-digest-core"
import { renderWeeklyDigest } from "@maple/email/weekly-digest"
import { Database } from "@/platform/DatabaseLive"
import { dateToMs } from "@/platform/time"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { EdgeCacheService } from "@maple/cache"
import { clerkRequest } from "@/services/auth/clerk-request"
import {
	isOrgWarehouseQuarantined,
	quarantineOnConfigClassCause,
} from "@/services/warehouse/warehouse-org-quarantine"

import { formatWarehouseDateTime } from "@maple/query-engine"
import { summarizeCause } from "@/platform/describe-cause"
const SYSTEM_DIGEST_USER = UserId.make("system-digest")
const ROOT_ROLE = RoleName.make("root")

const toPersistenceError = (error: unknown) =>
	new DigestPersistenceError({
		message: error instanceof Error ? `${error.message}` : `Digest persistence error: ${String(error)}`,
	})

/** Row shapes matching query engine output (camelCase from CH DSL) */
interface ServiceOverviewRow {
	serviceName: string
	/** `serviceOverviewQuery` groups by (serviceName, environment) — both are part
	 * of the row identity, and dropping either collapses distinct rows together. */
	environment: string
	serviceNamespace: string
	throughput: number
	estimatedSpanCount: number
	errorCount: number
	estimatedErrorCount: number
	p95LatencyMs: number
}

interface ServiceOverviewCompareRow extends ServiceOverviewRow {
	period: "current" | "previous"
}

/** `custom_traces_breakdown` with `group_by_all` — one row for the whole window. */
interface TracesBreakdownRow {
	name: string
	count: number
	errorRate: number
	p95Duration: number
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

/** Empty arrays mean "the whole org", which is every pre-existing subscription. */
const UNSCOPED: DigestScope = { environments: [], namespaces: [] }

/**
 * Stable identity of a digest render: two subscribers with the same scope share
 * one set of warehouse queries and one rendered email.
 */
const scopeKey = (orgId: string, scope: DigestScope): string =>
	JSON.stringify([orgId, [...scope.environments].sort(), [...scope.namespaces].sort()])

/** `[]` for anything that is not a JSON array of strings — a malformed scope
 * column must widen the digest, never fail the send. */
const parseScopeColumn = (raw: string | null): ReadonlyArray<string> => {
	if (raw == null || raw === "") return []
	const parsed = JSON.parse(raw) as unknown
	if (!Array.isArray(parsed)) return []
	return parsed.filter((value): value is string => typeof value === "string")
}

const csv = (values: ReadonlyArray<string>): string | undefined =>
	values.length === 0 ? undefined : values.join(",")

/** The (service, namespace, environment) grain the overview query actually
 * returns. Keying the previous-window lookup on the service name alone made
 * every environment of a service compare against whichever row happened to be
 * last, which is where the wildly wrong per-service percentages came from. */
const serviceKey = (row: { serviceName: string; serviceNamespace: string; environment: string }): string =>
	`${row.serviceName}\u0000${row.serviceNamespace}\u0000${row.environment}`

/** Rows in the service-health table, applied at the (service, environment)
 * grain the table actually renders. */
const DIGEST_SERVICE_LIMIT = 10

/**
 * Split the rendered services into one block per environment, ordered by
 * request volume, each block carrying its own subtotal and week-over-week
 * comparison. The subtotals cover the *rendered* services only, so they always
 * add up to what the reader can see.
 */
function groupServicesByEnvironment(
	services: ReadonlyArray<DigestServiceRow>,
	previous: ReadonlyArray<ServiceOverviewRow>,
): Array<DigestEnvironmentGroup> {
	const prevByEnvironment = new Map<string, number>()
	for (const row of previous) {
		const environment = String(row.environment ?? "")
		prevByEnvironment.set(
			environment,
			(prevByEnvironment.get(environment) ?? 0) + (Number(row.estimatedSpanCount) || 0),
		)
	}

	const byEnvironment = new Map<string, Array<DigestServiceRow>>()
	for (const service of services) {
		const bucket = byEnvironment.get(service.environment)
		if (bucket) bucket.push(service)
		else byEnvironment.set(service.environment, [service])
	}

	return [...byEnvironment.entries()]
		.map(([environment, groupServices]) => {
			const requests = groupServices.reduce((sum, s) => sum + s.requests, 0)
			return {
				environment,
				requests,
				requestsDelta: computeDelta(requests, prevByEnvironment.get(environment) ?? 0),
				services: groupServices,
			}
		})
		.sort((a, b) => b.requests - a.requests)
}

/**
 * Per-environment or per-namespace totals, aggregated from the overview rows
 * the digest already holds — no extra query. P95 is deliberately absent: the
 * per-service quantiles in these rows cannot be merged client-side, and
 * averaging them is exactly the bug this pass removes.
 */
function buildBreakdown(
	current: ReadonlyArray<ServiceOverviewRow>,
	previous: ReadonlyArray<ServiceOverviewRow>,
	dimension: (row: ServiceOverviewRow) => string,
): Array<DigestBreakdownRow> {
	const totals = new Map<string, { requests: number; errors: number }>()
	for (const row of current) {
		const label = dimension(row)
		const entry = totals.get(label) ?? { requests: 0, errors: 0 }
		entry.requests += Number(row.estimatedSpanCount) || 0
		entry.errors += Number(row.estimatedErrorCount) || 0
		totals.set(label, entry)
	}

	const prevTotals = new Map<string, number>()
	for (const row of previous) {
		const label = dimension(row)
		prevTotals.set(label, (prevTotals.get(label) ?? 0) + (Number(row.estimatedSpanCount) || 0))
	}

	return [...totals.entries()]
		.map(([label, { requests, errors }]) => ({
			label,
			requests,
			errorRate: requests > 0 ? (errors / requests) * 100 : 0,
			requestsDelta: computeDelta(requests, prevTotals.get(label) ?? 0),
		}))
		.sort((a, b) => b.requests - a.requests)
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
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)

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
				namespaces?: ReadonlyArray<string>
				environments?: ReadonlyArray<string>
			},
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)

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
							namespacesJson: JSON.stringify(input.namespaces ?? []),
							environmentsJson: JSON.stringify(input.environments ?? []),
							createdAt: new Date(now),
							updatedAt: new Date(now),
						})
						.onConflictDoUpdate({
							target: [digestSubscriptions.orgId, digestSubscriptions.userId],
							set: {
								email: input.email,
								enabled: input.enabled !== false,
								...(input.dayOfWeek != null ? { dayOfWeek: input.dayOfWeek } : undefined),
								...(input.timezone != null ? { timezone: input.timezone } : undefined),
								...(input.namespaces != null
									? { namespacesJson: JSON.stringify(input.namespaces) }
									: undefined),
								...(input.environments != null
									? { environmentsJson: JSON.stringify(input.environments) }
									: undefined),
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
			yield* Effect.annotateCurrentSpan("tenant.userId", userId)

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
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return String(orgId)
			if (Option.isNone(env.CLERK_SECRET_KEY)) return String(orgId)

			const clerk = createClerkClient({
				secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
			})

			return yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
				clerk.organizations.getOrganization({ organizationId: orgId }),
			).pipe(
				Effect.map((org) => org.name || String(orgId)),
				Effect.orElseSucceed(() => String(orgId)),
			)
		})

		const generateDigestData = Effect.fn("DigestService.generateDigestData")(function* (
			orgId: OrgId,
			scope: DigestScope = UNSCOPED,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("digest.environments", scope.environments.join(","))
			yield* Effect.annotateCurrentSpan("digest.namespaces", scope.namespaces.join(","))

			const now = new Date(yield* Clock.currentTimeMillis)

			// Every window is day-aligned to UTC midnight. `bucket_seconds: 86_400`
			// snaps `toStartOfInterval` to UTC midnight, so a rolling now-7d window
			// would split into 8 partial-day buckets (a duplicated weekday at the
			// seam). Aligning the *summary* windows to the same boundaries is what
			// makes the sparkline's bars add up to the headline Requests number —
			// they used to be measured over different spans.
			const DAY_MS = 24 * 60 * 60 * 1000
			const todayStartMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS
			const currentStartMs = todayStartMs - 7 * DAY_MS
			const previousStartMs = todayStartMs - 14 * DAY_MS

			const currentStart = formatWarehouseDateTime(currentStartMs)
			const currentEnd = formatWarehouseDateTime(todayStartMs - 1000)
			const previousStart = formatWarehouseDateTime(previousStartMs)
			const previousEnd = formatWarehouseDateTime(currentStartMs - 1000)

			const systemTenant = {
				orgId,
				userId: SYSTEM_DIGEST_USER,
				roles: [ROOT_ROLE] as ReadonlyArray<RoleNameType>,
				authMode: "self_hosted" as const,
			}

			// Filter params are omitted rather than sent empty: an empty string is a
			// filter for the empty environment, not the absence of a filter.
			const environmentsParam = csv(scope.environments)
			const namespacesParam = csv(scope.namespaces)
			const withScope = <T extends object>(params: T) => ({
				...params,
				...(environmentsParam === undefined ? undefined : { environments: environmentsParam }),
				...(namespacesParam === undefined ? undefined : { namespaces: namespacesParam }),
			})

			/** `errors_by_type` scopes by environment only — `error_events` has no
			 * `ServiceNamespace` column. */
			const withErrorScope = <T extends object>(params: T) => ({
				...params,
				...(environmentsParam === undefined ? undefined : { deployment_envs: environmentsParam }),
			})

			// Warm the route once before the fan-out, so the org-config read isn't
			// racing concurrent warehouse fetches for a connection slot.
			yield* warehouse.warmRoute(systemTenant)

			const warehouseFailure = (error: unknown) =>
				new DigestPersistenceError({
					message: `Failed to fetch digest data from the warehouse: ${error instanceof Error ? error.message : String(error)}`,
				})

			// `service_overview_compare` and `get_service_usage_compare` UNION ALL
			// current + previous into one query, tagging rows with `period`. The two
			// `custom_traces_breakdown` calls collapse to a single row each
			// (`group_by_all`) so the P95 is a real merged quantile rather than a
			// throughput-weighted mean of per-service P95s, which is not a quantile.
			const [overviewResponse, curSummary, prevSummary, seriesResponse, topErrors] = yield* Effect.all(
				[
					warehouse.query(systemTenant, {
						pipeName: "service_overview_compare",
						params: withScope({
							current_start_time: currentStart,
							current_end_time: currentEnd,
							previous_start_time: previousStart,
							previous_end_time: previousEnd,
						}),
					}),
					warehouse.query(systemTenant, {
						pipeName: "custom_traces_breakdown",
						params: withScope({
							start_time: currentStart,
							end_time: currentEnd,
							group_by_all: "1",
							root_only: "1",
							limit: 1,
						}),
					}),
					warehouse.query(systemTenant, {
						pipeName: "custom_traces_breakdown",
						params: withScope({
							start_time: previousStart,
							end_time: previousEnd,
							group_by_all: "1",
							root_only: "1",
							limit: 1,
						}),
					}),
					warehouse.query(systemTenant, {
						pipeName: "custom_traces_timeseries",
						params: withScope({
							start_time: currentStart,
							end_time: currentEnd,
							bucket_seconds: 86_400,
							root_only: "1",
						}),
					}),
					warehouse.query(systemTenant, {
						pipeName: "errors_by_type",
						params: withErrorScope({
							start_time: currentStart,
							end_time: currentEnd,
							limit: 5,
						}),
					}),
				],
				{ concurrency: 5 },
			).pipe(Effect.mapError(warehouseFailure))

			// Split UNION ALL'd rows by period discriminator
			const overviewRows = overviewResponse.data as Array<ServiceOverviewCompareRow>
			const curOverviewData: Array<ServiceOverviewRow> = overviewRows.filter(
				(r) => r.period === "current",
			)
			const prevOverviewData: Array<ServiceOverviewRow> = overviewRows.filter(
				(r) => r.period === "previous",
			)

			// `service_usage` has no environment or namespace column, so a scoped
			// digest can only narrow ingestion by service membership — the same
			// approximation the web app makes. A service emitting under two
			// namespaces stays counted in both.
			const scopedServiceNames = [...new Set(curOverviewData.map((r) => String(r.serviceName)))]
			const isScoped = scope.environments.length > 0 || scope.namespaces.length > 0
			// `service_usage` has neither dimension, so the only available narrowing
			// is the service list the scope resolved to.
			const usageServices = isScoped && scopedServiceNames.length > 0 ? scopedServiceNames : undefined
			const usageParams = {
				current_start_time: currentStart,
				current_end_time: currentEnd,
				previous_start_time: previousStart,
				previous_end_time: previousEnd,
				...(usageServices === undefined ? undefined : { services: usageServices.join(",") }),
			}

			const usageResponse = yield* warehouse
				.query(systemTenant, {
					pipeName: "get_service_usage_compare",
					params: usageParams,
				})
				.pipe(Effect.mapError(warehouseFailure))

			const summaryRow = (response: { data: unknown }): TracesBreakdownRow => {
				const row = (response.data as Array<TracesBreakdownRow>)[0]
				return {
					name: "all",
					count: Number(row?.count) || 0,
					errorRate: Number(row?.errorRate) || 0,
					p95Duration: Number(row?.p95Duration) || 0,
				}
			}
			const cur = summaryRow(curSummary)
			const prev = summaryRow(prevSummary)

			// `errorRate` here is a fraction (0–1), weighted on both sides of the
			// ratio — not the 0–100 percentage the per-service rows carry.
			const totalRequests = cur.count
			const prevTotalRequests = prev.count
			const totalErrors = Math.round(cur.count * cur.errorRate)
			const prevTotalErrors = Math.round(prev.count * prev.errorRate)

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

			const formatDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

			// Per-service WoW deltas, matched on the grain the query actually
			// returns rather than on the service name alone.
			const prevRequestsByService = new Map<string, number>()
			for (const s of prevOverviewData) {
				prevRequestsByService.set(serviceKey(s), Number(s.estimatedSpanCount) || 0)
			}

			const services: Array<DigestServiceRow> = curOverviewData
				.map((s) => {
					// `estimatedSpanCount` is the sample-weighted count, matching the
					// summary cards and the rest of the product; `throughput` is the raw
					// stored-row count and disagrees with both under any sampling.
					const requests = Number(s.estimatedSpanCount) || 0
					const errors = Number(s.estimatedErrorCount) || 0
					return {
						name: String(s.serviceName),
						environment: String(s.environment ?? ""),
						namespace: String(s.serviceNamespace ?? ""),
						requests,
						errorRate: requests > 0 ? (errors / requests) * 100 : 0,
						p95Ms: Number(s.p95LatencyMs) || 0,
						requestsDelta: computeDelta(requests, prevRequestsByService.get(serviceKey(s)) ?? 0),
					}
				})
				.sort((a, b) => b.requests - a.requests)
				.slice(0, DIGEST_SERVICE_LIMIT)
				// Float the unhealthiest services to the top so problems surface
				// first. Array.sort is stable, so ties keep their request order.
				.sort((a, b) => b.errorRate - a.errorRate)

			const environmentGroups = groupServicesByEnvironment(services, prevOverviewData)
			const breakdown = {
				environments: buildBreakdown(curOverviewData, prevOverviewData, (r) =>
					String(r.environment ?? ""),
				),
				namespaces: buildBreakdown(curOverviewData, prevOverviewData, (r) =>
					String(r.serviceNamespace ?? ""),
				),
			}

			// `errors_by_type` returns `min(Timestamp)` *within the window*, which is
			// always inside it — so newness has to be asked of the previous window
			// directly. Filtering to the five fingerprints we actually render makes
			// that exact, unlike diffing against the previous week's top 100.
			const currentErrors = (topErrors.data as Array<ErrorsByTypeRow>).slice(0, 5)
			const currentFingerprints = currentErrors
				.map((e) => String(e.fingerprintHash))
				.filter((hash) => hash !== "")
			const prevErrorFingerprints = yield* currentFingerprints.length === 0
				? Effect.succeed(new Set<string>())
				: warehouse
						.query(systemTenant, {
							pipeName: "errors_by_type",
							params: withErrorScope({
								start_time: previousStart,
								end_time: previousEnd,
								fingerprint_hashes: currentFingerprints.join(","),
								limit: currentFingerprints.length,
							}),
						})
						.pipe(
							Effect.map(
								(response) =>
									new Set(
										(response.data as Array<ErrorsByTypeRow>).map((e) =>
											String(e.fingerprintHash),
										),
									),
							),
							// A missing previous window costs the NEW badges, not the digest.
							Effect.orElseSucceed(() => new Set<string>()),
						)

			const errorsData = currentErrors.map((e) => ({
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

			const props: WeeklyDigestProps = {
				orgName,
				dateRange: {
					start: formatDate(new Date(currentStartMs)),
					end: formatDate(new Date(todayStartMs - DAY_MS)),
				},
				scope,
				summary: {
					requests: {
						value: totalRequests,
						delta: computeDelta(totalRequests, prevTotalRequests),
					},
					errors: {
						value: totalErrors,
						delta: computeDelta(totalErrors, prevTotalErrors),
					},
					p95Latency: {
						valueMs: cur.p95Duration,
						delta: computeDelta(cur.p95Duration, prev.p95Duration, "ms"),
					},
					dataVolume: {
						valueBytes: curUsage.totalBytes,
						delta: computeDelta(curUsage.totalBytes, prevUsage.totalBytes, "bytes"),
					},
				},
				series,
				services,
				environmentGroups,
				breakdown,
				topErrors: errorsData,
				ingestion: { ...curUsage, approximate: isScoped },
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
					environments: scope.environments.join(","),
					namespaces: scope.namespaces.join(","),
				}),
			)

			return props
		})

		const renderDigestHtml = Effect.fn("DigestService.renderDigestHtml")(function* (
			props: WeeklyDigestProps,
		) {
			return yield* Effect.try({
				// Synchronous: the template is a compiled string, spliced in place.
				try: () => renderWeeklyDigest(props),
				catch: (error) =>
					new DigestRenderError({
						message: error instanceof Error ? error.message : "Failed to render digest email",
					}),
			})
		})

		const preview = Effect.fn("DigestService.preview")(function* (orgId: OrgId, userId?: UserId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)

			if (!email.isConfigured) {
				return yield* new DigestNotConfiguredError({
					message: "Email delivery is not configured",
				})
			}

			// Preview what this subscriber would actually receive, scope included.
			// A caller with no subscription yet previews the whole org.
			const scope = userId
				? yield* getSubscription(orgId, userId).pipe(
						Effect.map(
							(sub): DigestScope => ({
								environments: sub.environments,
								namespaces: sub.namespaces,
							}),
						),
						Effect.orElseSucceed(() => UNSCOPED),
					)
				: UNSCOPED

			const props = yield* generateDigestData(orgId, scope)
			const html = yield* renderDigestHtml(props)
			return new DigestPreviewResponse({ html })
		})

		const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
		const lastSyncAt = yield* Ref.make<number | null>(null)

		const paginateClerk = <T>(
			spanName: string,
			attributes: Readonly<Record<string, string>>,
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
					const page = yield* clerkRequest(spanName, attributes, () =>
						fetchPage({ limit: PAGE_SIZE, offset }),
					).pipe(Effect.mapError(() => new DigestPersistenceError({ message: errorMessage })))
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
				"Clerk.organizations.getOrganizationList",
				{},
				(params) => clerk.organizations.getOrganizationList(params),
				"Failed to list Clerk organizations",
			)

			const perOrgMemberships = yield* Effect.forEach(orgs, (org) =>
				Effect.gen(function* () {
					const members = yield* paginateClerk(
						"Clerk.organizations.getOrganizationMembershipList",
						{ orgId: org.id },
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
						return [
							{
								orgId: OrgId.make(org.id),
								userId: UserId.make(memberUserId),
								email: memberEmail,
							},
						]
					})
				}),
			)

			return perOrgMemberships.flat()
		})

		const reconcileSubscriptions = Effect.fn("DigestService.reconcileSubscriptions")(function* (
			clerkMemberships: Array<{ orgId: OrgId; userId: UserId; email: string }>,
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

			const existingSubs = yield* database
				.execute((db) =>
					db
						.select({
							id: digestSubscriptions.id,
							orgId: digestSubscriptions.orgId,
							userId: digestSubscriptions.userId,
						})
						.from(digestSubscriptions)
						.where(inArray(digestSubscriptions.orgId, activeOrgIds)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const activeKeys = new Set(clerkMemberships.map((m) => `${m.orgId}:${m.userId}`))
			const staleIds = existingSubs
				.filter((s) => !activeKeys.has(`${s.orgId}:${s.userId}`))
				.map((s) => s.id)

			if (staleIds.length > 0) {
				yield* database
					.execute((db) =>
						db
							.update(digestSubscriptions)
							.set({ enabled: false, updatedAt: new Date(now) })
							.where(inArray(digestSubscriptions.id, staleIds)),
					)
					.pipe(Effect.mapError(toPersistenceError))

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
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("Failed to seed digest subscriptions").pipe(
								Effect.annotateLogs({ error: summarizeCause(cause) }),
							),
				),
			)

			const now = yield* Clock.currentTimeMillis
			const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
			const todayStartMs = now - (now % 86_400_000)
			const currentDayOfWeek = new Date(now).getUTCDay()

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

			// Grouped by (org, scope) rather than by org: subscribers who asked for
			// the same slice still share one render and one set of warehouse
			// queries, while a differently-scoped subscriber gets their own.
			const byScope = Arr.groupBy(dueSubs, (s) =>
				scopeKey(s.orgId, {
					environments: parseScopeColumn(s.environmentsJson),
					namespaces: parseScopeColumn(s.namespacesJson),
				}),
			)

			const results = yield* Effect.forEach(
				Object.values(byScope),
				(orgSubs) => {
					// Every subscription in the group shares an org and a scope by
					// construction, so the first row speaks for all of them.
					const head = orgSubs[0]!
					const rawOrgId = head.orgId
					const scope: DigestScope = {
						environments: parseScopeColumn(head.environmentsJson),
						namespaces: parseScopeColumn(head.namespacesJson),
					}

					return Effect.gen(function* () {
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
												lt(
													digestSubscriptions.lastAttemptedAt,
													new Date(todayStartMs),
												),
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
							yield* Effect.logInfo(
								"Skipping digest subscriptions already attempted today",
							).pipe(
								Effect.annotateLogs({
									orgId: rawOrgId,
									skippedCount: orgSubs.length - claimedSubs.length,
									claimedCount: claimedSubs.length,
								}),
							)
						}

						const props = yield* generateDigestData(orgId, scope)
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
												Cause.hasInterruptsOnly(cause)
													? Effect.interrupt
													: Effect.logWarning(
															"Failed to record digest lastSentAt",
														).pipe(
															Effect.annotateLogs({
																subscriptionId: sub.id,
																orgId: rawOrgId,
																error: summarizeCause(cause),
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
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.gen(function* () {
										const quarantined = yield* quarantineOnConfigClassCause(
											edgeCache,
											rawOrgId,
											cause,
											now,
										)
										if (quarantined) {
											yield* Effect.logInfo(
												"Org warehouse rejected queries with a config-class error; quarantined",
											).pipe(
												Effect.annotateLogs({
													orgId: rawOrgId,
													error: summarizeCause(cause),
												}),
											)
										} else {
											yield* Effect.logError("Digest failed for org").pipe(
												Effect.annotateLogs({
													orgId: rawOrgId,
													error: summarizeCause(cause),
												}),
											)
										}
										return orgSubs.map(() => ({ sent: false }))
									}),
						),
					)
				},
				{ concurrency: 1 },
			)

			const allResults = results.flat()
			const sentCount = allResults.filter((r) => r.sent).length
			const errorCount = allResults.filter((r) => !r.sent).length

			yield* Effect.annotateCurrentSpan("sentCount", sentCount)
			yield* Effect.annotateCurrentSpan("errorCount", errorCount)
			yield* Effect.annotateCurrentSpan("scopeCount", Object.keys(byScope).length)

			return { sentCount, errorCount, skipped: false }
		})

		return {
			getSubscription,
			upsertSubscription,
			deleteSubscription,
			// Exposed so the shape of a digest can be asserted directly rather than
			// through rendered HTML.
			generateDigestData,
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
		namespaces: parseScopeColumn(row.namespacesJson),
		environments: parseScopeColumn(row.environmentsJson),
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
