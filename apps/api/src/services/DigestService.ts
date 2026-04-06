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
import { and, eq } from "drizzle-orm"
import { Array as Arr, Cause, Effect, Layer, Option, Redacted, ServiceMap } from "effect"
import { WeeklyDigest, type WeeklyDigestProps } from "@maple/email/weekly-digest"
import { Database } from "./DatabaseLive"
import { EmailService } from "./EmailService"
import { Env } from "./Env"
import { TinybirdService } from "./TinybirdService"

const SYSTEM_DIGEST_USER = UserId.makeUnsafe("system-digest")
const ROOT_ROLE = RoleName.makeUnsafe("root")

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

interface ErrorsByTypeRow {
  errorType: string
  sampleMessage: string
  count: number
}

export class DigestService extends ServiceMap.Service<DigestService>()(
  "DigestService",
  {
    make: Effect.gen(function* () {
      const database = yield* Database
      const email = yield* EmailService
      const env = yield* Env
      const tinybird = yield* TinybirdService

      const getSubscription = Effect.fn("DigestService.getSubscription")(
        function* (orgId: OrgId, userId: UserId) {
          yield* Effect.annotateCurrentSpan("orgId", orgId)
          yield* Effect.annotateCurrentSpan("userId", userId)

          const rows = yield* database
            .execute((db) =>
              db
                .select()
                .from(digestSubscriptions)
                .where(
                  and(
                    eq(digestSubscriptions.orgId, orgId),
                    eq(digestSubscriptions.userId, userId),
                  ),
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
        },
      )

      const upsertSubscription = Effect.fn(
        "DigestService.upsertSubscription",
      )(function* (
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
                  ...(input.dayOfWeek != null
                    ? { dayOfWeek: input.dayOfWeek }
                    : {}),
                  ...(input.timezone != null
                    ? { timezone: input.timezone }
                    : {}),
                  updatedAt: now,
                },
              }),
          )
          .pipe(Effect.mapError(toPersistenceError))

        return yield* getSubscription(orgId, userId)
      })

      const deleteSubscription = Effect.fn(
        "DigestService.deleteSubscription",
      )(function* (orgId: OrgId, userId: UserId) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)
        yield* Effect.annotateCurrentSpan("userId", userId)

        yield* database
          .execute((db) =>
            db
              .delete(digestSubscriptions)
              .where(
                and(
                  eq(digestSubscriptions.orgId, orgId),
                  eq(digestSubscriptions.userId, userId),
                ),
              ),
          )
          .pipe(Effect.mapError(toPersistenceError))
      })

      const generateDigestData = Effect.fn(
        "DigestService.generateDigestData",
      )(function* (orgId: OrgId) {
        yield* Effect.annotateCurrentSpan("orgId", orgId)

        const now = new Date()
        const toClickHouseDateTime = (d: Date) =>
          d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
        const currentEnd = toClickHouseDateTime(now)
        const currentStart = toClickHouseDateTime(new Date(
          now.getTime() - 7 * 24 * 60 * 60 * 1000,
        ))
        const previousStart = toClickHouseDateTime(new Date(
          now.getTime() - 14 * 24 * 60 * 60 * 1000,
        ))

        const systemTenant = {
          orgId,
          userId: SYSTEM_DIGEST_USER,
          roles: [ROOT_ROLE] as ReadonlyArray<RoleNameType>,
          authMode: "self_hosted" as const,
        }

        // Query all data in parallel
        const [
          currentOverview,
          previousOverview,
          currentErrors,
          currentUsage,
          previousUsage,
          topErrors,
        ] = yield* Effect.all(
          [
            tinybird.query(systemTenant, {
              pipe: "service_overview",
              params: { start_time: currentStart, end_time: currentEnd },
            }),
            tinybird.query(systemTenant, {
              pipe: "service_overview",
              params: { start_time: previousStart, end_time: currentStart },
            }),
            tinybird.query(systemTenant, {
              pipe: "errors_summary",
              params: { start_time: currentStart, end_time: currentEnd },
            }),
            tinybird.query(systemTenant, {
              pipe: "get_service_usage",
              params: { start_time: currentStart, end_time: currentEnd },
            }),
            tinybird.query(systemTenant, {
              pipe: "get_service_usage",
              params: { start_time: previousStart, end_time: currentStart },
            }),
            tinybird.query(systemTenant, {
              pipe: "errors_by_type",
              params: {
                start_time: currentStart,
                end_time: currentEnd,
                limit: 5,
              },
            }),
          ],
          { concurrency: 6 },
        ).pipe(
          Effect.mapError(
            (error) =>
              new DigestPersistenceError({
                message: `Failed to fetch digest data from Tinybird: ${error instanceof Error ? error.message : String(error)}`,
              }),
          ),
        )

        void currentErrors

        // Aggregate service health
        const curOverviewData = currentOverview.data as Array<ServiceOverviewRow>
        const prevOverviewData = previousOverview.data as Array<ServiceOverviewRow>

        const totalRequests = curOverviewData.reduce(
          (sum, s) => sum + (Number(s.throughput) || 0),
          0,
        )
        const prevTotalRequests = prevOverviewData.reduce(
          (sum, s) => sum + (Number(s.throughput) || 0),
          0,
        )

        const totalErrors = curOverviewData.reduce(
          (sum, s) => sum + (Number(s.errorCount) || 0),
          0,
        )
        const prevTotalErrors = prevOverviewData.reduce(
          (sum, s) => sum + (Number(s.errorCount) || 0),
          0,
        )

        // Weighted avg P95
        const avgP95 =
          totalRequests > 0
            ? curOverviewData.reduce(
                (sum, s) =>
                  sum +
                  (Number(s.p95LatencyMs) || 0) *
                    (Number(s.throughput) || 0),
                0,
              ) / totalRequests
            : 0
        const prevAvgP95 =
          prevTotalRequests > 0
            ? prevOverviewData.reduce(
                (sum, s) =>
                  sum +
                  (Number(s.p95LatencyMs) || 0) *
                    (Number(s.throughput) || 0),
                0,
              ) / prevTotalRequests
            : 0

        // Data volume
        const curUsageData = currentUsage.data as Array<ServiceUsageRow>
        const prevUsageData = previousUsage.data as Array<ServiceUsageRow>
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

        const formatDate = (d: Date) =>
          d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

        const services = curOverviewData
          .sort(
            (a, b) =>
              (Number(b.throughput) || 0) - (Number(a.throughput) || 0),
          )
          .slice(0, 10)
          .map((s) => ({
            name: String(s.serviceName),
            requests: Number(s.throughput) || 0,
            errorRate:
              (Number(s.throughput) || 0) > 0
                ? ((Number(s.errorCount) || 0) /
                    (Number(s.throughput) || 0)) *
                  100
                : 0,
            p95Ms: Number(s.p95LatencyMs) || 0,
          }))

        const errorsData = (topErrors.data as Array<ErrorsByTypeRow>)
          .slice(0, 5)
          .map((e) => ({
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

      const renderDigestHtml = Effect.fn("DigestService.renderDigestHtml")(
        function* (props: WeeklyDigestProps) {
          return yield* Effect.tryPromise({
            try: () => render(WeeklyDigest(props)),
            catch: (error) =>
              new DigestRenderError({
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to render digest email",
              }),
          })
        },
      )

      const preview = Effect.fn("DigestService.preview")(function* (
        orgId: OrgId,
      ) {
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

      const ensureSubscriptions = Effect.fn("DigestService.ensureSubscriptions")(
        function* () {
          if (env.MAPLE_AUTH_MODE.toLowerCase() !== "clerk") return
          if (Option.isNone(env.CLERK_SECRET_KEY)) return

          const clerk = createClerkClient({
            secretKey: Redacted.value(env.CLERK_SECRET_KEY.value),
          })

          const orgs = Option.isSome(env.MAPLE_ORG_ID_OVERRIDE)
            ? [{ id: env.MAPLE_ORG_ID_OVERRIDE.value }]
            : (yield* Effect.tryPromise({
                try: () => clerk.organizations.getOrganizationList({ limit: 100 }),
                catch: () => new DigestPersistenceError({ message: "Failed to list Clerk organizations" }),
              })).data

          for (const org of orgs) {
            const members = yield* Effect.tryPromise({
              try: () => clerk.organizations.getOrganizationMembershipList({
                organizationId: org.id,
                limit: 100,
              }),
              catch: () => new DigestPersistenceError({ message: `Failed to list Clerk members for org ${org.id}` }),
            })

            const now = Date.now()
            for (const member of members.data) {
              const memberEmail = member.publicUserData?.identifier
              const memberUserId = member.publicUserData?.userId
              if (!memberEmail || !memberUserId) continue

              yield* database
                .execute((db) =>
                  db
                    .insert(digestSubscriptions)
                    .values({
                      id: crypto.randomUUID(),
                      orgId: org.id,
                      userId: memberUserId,
                      email: memberEmail,
                      enabled: 1,
                      dayOfWeek: 1,
                      timezone: "UTC",
                      createdAt: now,
                      updatedAt: now,
                    })
                    .onConflictDoNothing({
                      target: [digestSubscriptions.orgId, digestSubscriptions.userId],
                    }),
                )
                .pipe(Effect.mapError(toPersistenceError))
            }
          }

          yield* Effect.logInfo("Digest subscriptions seeded from Clerk")
        },
      )

      const runDigestTick = Effect.fn("DigestService.runDigestTick")(
        function* () {
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
          const currentDayOfWeek = new Date().getUTCDay()

          // Find subscriptions due for sending
          const subs = yield* database
            .execute((db) =>
              db
                .select()
                .from(digestSubscriptions)
                .where(eq(digestSubscriptions.enabled, 1)),
            )
            .pipe(Effect.mapError(toPersistenceError))

          const dueSubs = subs.filter(
            (s) =>
              s.dayOfWeek === currentDayOfWeek &&
              (s.lastSentAt == null || s.lastSentAt < sevenDaysAgo),
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
                const orgId = OrgId.makeUnsafe(rawOrgId)
                const props = yield* generateDigestData(orgId)
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
                    Effect.map(() =>
                      orgSubs.map(() => ({ sent: false })),
                    ),
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
        },
      )

      return {
        getSubscription,
        upsertSubscription,
        deleteSubscription,
        preview,
        runDigestTick,
      }
    }),
  },
) {
  static readonly Default = Layer.effect(this, this.make)
}

function rowToResponse(
  row: typeof digestSubscriptions.$inferSelect,
): DigestSubscriptionResponse {
  return new DigestSubscriptionResponse({
    id: DigestSubscriptionId.makeUnsafe(row.id),
    email: row.email,
    enabled: row.enabled === 1,
    dayOfWeek: row.dayOfWeek,
    timezone: row.timezone,
    lastSentAt: row.lastSentAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}
