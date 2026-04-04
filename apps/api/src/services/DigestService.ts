import { digestSubscriptions } from "@maple/db"
import type {
  DigestSubscriptionResponse,
  DigestPreviewResponse,
} from "@maple/domain/http"
import {
  DigestNotConfiguredError,
  DigestPersistenceError,
} from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/domain/http"
import { render } from "@react-email/components"
import { and, eq } from "drizzle-orm"
import { Cause, Effect, Layer, ServiceMap } from "effect"
import { WeeklyDigest, type WeeklyDigestProps } from "@maple/email/weekly-digest"
import { Database } from "./DatabaseLive"
import { EmailService } from "./EmailService"
import { Env } from "./Env"
import { TinybirdService } from "./TinybirdService"

const toPersistenceError = (error: unknown) =>
  new DigestPersistenceError({
    message: error instanceof Error ? error.message : "Digest persistence error",
  })

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
            return yield* Effect.fail(
              new DigestPersistenceError({
                message: "No digest subscription found",
              }),
            )
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
        const now = new Date()
        const currentEnd = now.toISOString()
        const currentStart = new Date(
          now.getTime() - 7 * 24 * 60 * 60 * 1000,
        ).toISOString()
        const previousStart = new Date(
          now.getTime() - 14 * 24 * 60 * 60 * 1000,
        ).toISOString()

        const systemTenant = {
          orgId,
          userId: "system-digest" as UserId,
          roles: ["root"] as any,
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
            () =>
              new DigestPersistenceError({
                message: "Failed to fetch digest data from Tinybird",
              }),
          ),
        )

        // Aggregate service health
        const curOverviewData = currentOverview.data as Array<Record<string, any>>
        const prevOverviewData = previousOverview.data as Array<Record<string, any>>

        const totalRequests = curOverviewData.reduce(
          (sum, s) => sum + (Number(s.total_count) || 0),
          0,
        )
        const prevTotalRequests = prevOverviewData.reduce(
          (sum, s) => sum + (Number(s.total_count) || 0),
          0,
        )

        const totalErrors = curOverviewData.reduce(
          (sum, s) => sum + (Number(s.error_count) || 0),
          0,
        )
        const prevTotalErrors = prevOverviewData.reduce(
          (sum, s) => sum + (Number(s.error_count) || 0),
          0,
        )

        // Weighted avg P95
        const avgP95 =
          totalRequests > 0
            ? curOverviewData.reduce(
                (sum, s) =>
                  sum +
                  (Number(s.p95_duration_ms) || 0) *
                    (Number(s.total_count) || 0),
                0,
              ) / totalRequests
            : 0
        const prevAvgP95 =
          prevTotalRequests > 0
            ? prevOverviewData.reduce(
                (sum, s) =>
                  sum +
                  (Number(s.p95_duration_ms) || 0) *
                    (Number(s.total_count) || 0),
                0,
              ) / prevTotalRequests
            : 0

        // Data volume
        const curUsageData = currentUsage.data as Array<Record<string, any>>
        const prevUsageData = previousUsage.data as Array<Record<string, any>>
        const sumUsage = (data: Array<Record<string, any>>) => ({
          logs: data.reduce((s, r) => s + (Number(r.log_count) || 0), 0),
          traces: data.reduce((s, r) => s + (Number(r.trace_count) || 0), 0),
          metrics: data.reduce(
            (s, r) =>
              s +
              (Number(r.sum_metric_count) || 0) +
              (Number(r.gauge_metric_count) || 0) +
              (Number(r.histogram_metric_count) || 0) +
              (Number(r.exp_histogram_metric_count) || 0),
            0,
          ),
          totalBytes: data.reduce(
            (s, r) =>
              s +
              (Number(r.log_size_bytes) || 0) +
              (Number(r.trace_size_bytes) || 0) +
              (Number(r.sum_metric_size_bytes) || 0) +
              (Number(r.gauge_metric_size_bytes) || 0) +
              (Number(r.histogram_metric_size_bytes) || 0) +
              (Number(r.exp_histogram_metric_size_bytes) || 0),
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
              (Number(b.total_count) || 0) - (Number(a.total_count) || 0),
          )
          .slice(0, 10)
          .map((s) => ({
            name: String(s.service_name),
            requests: Number(s.total_count) || 0,
            errorRate:
              (Number(s.total_count) || 0) > 0
                ? ((Number(s.error_count) || 0) /
                    (Number(s.total_count) || 0)) *
                  100
                : 0,
            p95Ms: Number(s.p95_duration_ms) || 0,
          }))

        const errorsData = (topErrors.data as Array<Record<string, any>>)
          .slice(0, 5)
          .map((e) => ({
            message: String(e.error_fingerprint || e.status_message || "Unknown"),
            count: Number(e.error_count) || 0,
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

        return props
      })

      const renderDigestHtml = Effect.fn("DigestService.renderDigestHtml")(
        function* (props: WeeklyDigestProps) {
          return yield* Effect.tryPromise({
            try: () => render(WeeklyDigest(props)),
            catch: (error) =>
              new DigestPersistenceError({
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
        const props = yield* generateDigestData(orgId)
        const html = yield* renderDigestHtml(props)
        return { html } as DigestPreviewResponse
      })

      const runDigestTick = Effect.fn("DigestService.runDigestTick")(
        function* () {
          if (!email.isConfigured) {
            return { sentCount: 0, errorCount: 0, skipped: true }
          }

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
          const byOrg = new Map<string, typeof dueSubs>()
          for (const sub of dueSubs) {
            const existing = byOrg.get(sub.orgId) ?? []
            existing.push(sub)
            byOrg.set(sub.orgId, existing)
          }

          let sentCount = 0
          let errorCount = 0

          for (const [orgId, orgSubs] of byOrg) {
            const sendForOrg = Effect.gen(function* () {
              const props = yield* generateDigestData(orgId as OrgId)
              const html = yield* renderDigestHtml(props)

              for (const sub of orgSubs) {
                yield* email
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
                      onSuccess: () => { sentCount++ },
                      onFailure: () => { errorCount++ },
                    }),
                  )
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Digest failed for org").pipe(
                  Effect.annotateLogs({ orgId, error: Cause.pretty(cause) }),
                  Effect.tap(() =>
                    Effect.sync(() => { errorCount += orgSubs.length }),
                  ),
                ),
              ),
            )

            yield* sendForOrg
          }

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
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}

function rowToResponse(
  row: typeof digestSubscriptions.$inferSelect,
): DigestSubscriptionResponse {
  return {
    id: row.id,
    email: row.email,
    enabled: row.enabled === 1,
    dayOfWeek: row.dayOfWeek,
    timezone: row.timezone,
    lastSentAt: row.lastSentAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as DigestSubscriptionResponse
}
