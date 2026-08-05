import {
	alertDestinations,
	alertRules,
	alertRuleStates,
	anomalyDetectorSettings,
	cloudflareAnalyticsState,
	dashboards,
	errorNotificationPolicies,
	oauthConnections,
	orgClickHouseSettings,
	orgIngestAttributeMappings,
	orgIngestSamplingPolicies,
	orgOnboardingState,
	orgRecommendationIssues,
	scrapeTargets,
	vcsRepositories,
} from "@maple/db"
import { clickHouseSchemaVersion } from "@maple/domain/clickhouse"
import type { OrgId } from "@maple/domain/primitives"
import {
	type ConfigAuditInputs,
	type SetupAuditReport,
	type TraceCompletenessInputs,
	type WarehouseAuditInputs,
	runSetupAudit,
} from "@maple/domain/setup-audit"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { and, eq, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import * as Integrations from "@maple/query-engine-integrations"

/** Telemetry lookback for the warehouse-backed checks — matches the recommendations reconcile. */
const LOOKBACK_HOURS = 24

/**
 * The trace-completeness joins read one hour, trailing 15 minutes behind now so exporter batching
 * cannot masquerade as a missing parent, with an extra hour of parent lookback for long spans. Same
 * shape and window size as the hourly service-map rollup, which is the cost precedent — do not widen.
 */
const TRACE_WINDOW_MINUTES = 60
const TRACE_WINDOW_LAG_MINUTES = 15
const TRACE_PARENT_LOOKBACK_MINUTES = 60

export class SetupAuditError extends Schema.TaggedErrorClass<SetupAuditError>()(
	"@maple/api/services/SetupAuditError",
	{ message: Schema.String },
) {}

export interface SetupAuditServiceShape {
	/** Runs every check against a fresh snapshot of config + telemetry. */
	readonly run: (tenant: TenantContext) => Effect.Effect<SetupAuditReport, SetupAuditError>
}

const msOrNull = (value: Date | null | undefined): number | null => value?.getTime() ?? null

const make: Effect.Effect<SetupAuditServiceShape, never, Database | WarehouseQueryService> = Effect.gen(
	function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const runDb = <A>(
			operation: string,
			effect: Effect.Effect<A, DatabaseError>,
		): Effect.Effect<A, SetupAuditError> =>
			effect.pipe(
				Effect.tapCause((cause) =>
					Effect.logError("Setup audit database read failed").pipe(
						Effect.annotateLogs({ operation, cause }),
					),
				),
				Effect.mapError((error) => new SetupAuditError({ message: error.message })),
			)

		/**
		 * One pass over the org's configuration. Every read is a narrow column projection — the audit
		 * never needs secrets, payloads, or full rows, and keeping the projections narrow is what makes
		 * running ~15 selects per request cheap.
		 */
		const fetchConfigInputs = Effect.fn("SetupAuditService.fetchConfigInputs")(function* (orgId: OrgId) {
			const rows = yield* runDb(
				"config",
				database.execute(async (db) => {
					const [
						onboarding,
						rules,
						ruleStates,
						destinations,
						notificationPolicy,
						anomalySettings,
						dashboardRows,
						sampling,
						mappings,
						clickhouse,
						connections,
						cloudflare,
						repositories,
						targets,
						openRecommendations,
					] = await Promise.all([
						db
							.select({ firstDataReceivedAt: orgOnboardingState.firstDataReceivedAt })
							.from(orgOnboardingState)
							.where(eq(orgOnboardingState.orgId, orgId))
							.limit(1),
						db
							.select({
								id: alertRules.id,
								name: alertRules.name,
								enabled: alertRules.enabled,
								destinationIdsJson: alertRules.destinationIdsJson,
								windowMinutes: alertRules.windowMinutes,
								lastScheduledAt: alertRules.lastScheduledAt,
								createdAt: alertRules.createdAt,
							})
							.from(alertRules)
							.where(eq(alertRules.orgId, orgId)),
						db
							.select({
								ruleId: alertRuleStates.ruleId,
								lastEvaluatedAt: alertRuleStates.lastEvaluatedAt,
								lastError: alertRuleStates.lastError,
							})
							.from(alertRuleStates)
							.where(eq(alertRuleStates.orgId, orgId)),
						db
							.select({
								id: alertDestinations.id,
								name: alertDestinations.name,
								enabled: alertDestinations.enabled,
								lastTestError: alertDestinations.lastTestError,
							})
							.from(alertDestinations)
							.where(eq(alertDestinations.orgId, orgId)),
						db
							.select({
								enabled: errorNotificationPolicies.enabled,
								destinationIdsJson: errorNotificationPolicies.destinationIdsJson,
							})
							.from(errorNotificationPolicies)
							.where(eq(errorNotificationPolicies.orgId, orgId))
							.limit(1),
						db
							.select({ enabled: anomalyDetectorSettings.enabled })
							.from(anomalyDetectorSettings)
							.where(eq(anomalyDetectorSettings.orgId, orgId))
							.limit(1),
						db
							.select({ count: sql<number>`count(*)::int` })
							.from(dashboards)
							.where(eq(dashboards.orgId, orgId)),
						db
							.select({
								traceSampleRatio: orgIngestSamplingPolicies.traceSampleRatio,
								alwaysKeepErrorSpans: orgIngestSamplingPolicies.alwaysKeepErrorSpans,
							})
							.from(orgIngestSamplingPolicies)
							.where(eq(orgIngestSamplingPolicies.orgId, orgId))
							.limit(1),
						db
							.select({
								id: orgIngestAttributeMappings.id,
								name: orgIngestAttributeMappings.name,
								enabled: orgIngestAttributeMappings.enabled,
								sourceContext: orgIngestAttributeMappings.sourceContext,
								sourceKey: orgIngestAttributeMappings.sourceKey,
								targetKey: orgIngestAttributeMappings.targetKey,
							})
							.from(orgIngestAttributeMappings)
							.where(eq(orgIngestAttributeMappings.orgId, orgId)),
						db
							.select({
								syncStatus: orgClickHouseSettings.syncStatus,
								lastSyncError: orgClickHouseSettings.lastSyncError,
								schemaVersion: orgClickHouseSettings.schemaVersion,
							})
							.from(orgClickHouseSettings)
							.where(eq(orgClickHouseSettings.orgId, orgId))
							.limit(1),
						db
							.select({
								provider: oauthConnections.provider,
								revokedAt: oauthConnections.revokedAt,
							})
							.from(oauthConnections)
							.where(eq(oauthConnections.orgId, orgId)),
						db
							.select({
								dataset: cloudflareAnalyticsState.dataset,
								zoneName: cloudflareAnalyticsState.zoneName,
								enabled: cloudflareAnalyticsState.enabled,
								lastSuccessAt: cloudflareAnalyticsState.lastSuccessAt,
								lastErrorAt: cloudflareAnalyticsState.lastErrorAt,
								lastError: cloudflareAnalyticsState.lastError,
							})
							.from(cloudflareAnalyticsState)
							.where(eq(cloudflareAnalyticsState.orgId, orgId)),
						db
							.select({
								id: vcsRepositories.id,
								fullName: vcsRepositories.fullName,
								syncStatus: vcsRepositories.syncStatus,
								lastSyncError: vcsRepositories.lastSyncError,
							})
							.from(vcsRepositories)
							.where(eq(vcsRepositories.orgId, orgId)),
						db
							.select({
								id: scrapeTargets.id,
								name: scrapeTargets.name,
								enabled: scrapeTargets.enabled,
								lastScrapeError: scrapeTargets.lastScrapeError,
							})
							.from(scrapeTargets)
							.where(eq(scrapeTargets.orgId, orgId)),
						db
							.select({ count: sql<number>`count(*)::int` })
							.from(orgRecommendationIssues)
							.where(
								and(
									eq(orgRecommendationIssues.orgId, orgId),
									eq(orgRecommendationIssues.status, "open"),
								),
							),
					])

					return {
						onboarding,
						rules,
						ruleStates,
						destinations,
						notificationPolicy,
						anomalySettings,
						dashboardRows,
						sampling,
						mappings,
						clickhouse,
						connections,
						cloudflare,
						repositories,
						targets,
						openRecommendations,
					}
				}),
			)

			const clickhouseRow = rows.clickhouse[0]

			const config: ConfigAuditInputs = {
				firstDataReceivedAt: msOrNull(rows.onboarding[0]?.firstDataReceivedAt),
				alertRules: rows.rules.map((rule) => ({
					id: rule.id,
					name: rule.name,
					enabled: rule.enabled,
					destinationIds: rule.destinationIdsJson ?? [],
					windowMinutes: rule.windowMinutes,
					lastScheduledAt: msOrNull(rule.lastScheduledAt),
					createdAt: rule.createdAt.getTime(),
				})),
				alertRuleStates: rows.ruleStates.map((state) => ({
					ruleId: state.ruleId,
					lastEvaluatedAt: msOrNull(state.lastEvaluatedAt),
					lastError: state.lastError,
				})),
				alertDestinations: rows.destinations.map((destination) => ({
					id: destination.id,
					name: destination.name,
					enabled: destination.enabled,
					lastTestError: destination.lastTestError,
				})),
				errorNotificationPolicy: rows.notificationPolicy[0]
					? {
							enabled: rows.notificationPolicy[0].enabled,
							destinationIds: rows.notificationPolicy[0].destinationIdsJson ?? [],
						}
					: null,
				anomalyDetector: rows.anomalySettings[0]
					? { enabled: rows.anomalySettings[0].enabled }
					: null,
				dashboardCount: rows.dashboardRows[0]?.count ?? 0,
				samplingPolicy: rows.sampling[0]
					? {
							traceSampleRatio: rows.sampling[0].traceSampleRatio,
							alwaysKeepErrorSpans: rows.sampling[0].alwaysKeepErrorSpans,
						}
					: null,
				attributeMappings: rows.mappings.map((mapping) => ({
					id: mapping.id,
					name: mapping.name,
					enabled: mapping.enabled,
					sourceContext: mapping.sourceContext,
					sourceKey: mapping.sourceKey,
					targetKey: mapping.targetKey,
				})),
				clickhouse: clickhouseRow
					? {
							syncStatus: clickhouseRow.syncStatus,
							lastSyncError: clickhouseRow.lastSyncError,
							schemaVersion: clickhouseRow.schemaVersion,
							expectedSchemaVersion: clickHouseSchemaVersion,
						}
					: null,
				integrations: rows.connections.map((connection) => ({
					provider: connection.provider,
					revokedAt: msOrNull(connection.revokedAt),
				})),
				// Disabled datasets are not collected at all, so a stale error on one is not a finding.
				cloudflareAnalytics: rows.cloudflare
					.filter((state) => state.enabled)
					.map((state) => ({
						dataset: state.dataset,
						zoneName: state.zoneName,
						lastSuccessAt: msOrNull(state.lastSuccessAt),
						lastErrorAt: msOrNull(state.lastErrorAt),
						lastError: state.lastError,
					})),
				vcsRepositories: rows.repositories.map((repository) => ({
					id: repository.id,
					fullName: repository.fullName,
					syncStatus: repository.syncStatus,
					lastSyncError: repository.lastSyncError,
				})),
				scrapeTargets: rows.targets.map((target) => ({
					id: target.id,
					name: target.name,
					enabled: target.enabled,
					lastScrapeError: target.lastScrapeError,
				})),
				openRecommendationCount: rows.openRecommendations[0]?.count ?? 0,
			}

			return config
		})

		/**
		 * The two cross-span joins, over a short lagged window.
		 *
		 * `TRACE_WINDOW_LAG_MINUTES` keeps the window clear of spans still in flight — a span row is
		 * written when the span *ends*, so a parent that is merely slow to export would otherwise read
		 * as missing. `TRACE_PARENT_LOOKBACK_MINUTES` extends only the parent side, because a span's
		 * `Timestamp` is its start and a parent always starts no later than its child.
		 */
		const fetchTraceCompleteness = Effect.fn("SetupAuditService.fetchTraceCompleteness")(function* (
			tenant: TenantContext,
			now: number,
			spanCountOverLookback: number,
		) {
			const childEnd = now - TRACE_WINDOW_LAG_MINUTES * 60_000
			const childStart = childEnd - TRACE_WINDOW_MINUTES * 60_000
			const window = {
				orgId: tenant.orgId,
				childStart: formatWarehouseDateTime(childStart),
				childEnd: formatWarehouseDateTime(childEnd),
				parentStart: formatWarehouseDateTime(childStart - TRACE_PARENT_LOOKBACK_MINUTES * 60_000),
				traceSampleModulus: Integrations.auditTraceSampleModulus(spanCountOverLookback),
			}

			// Warm the route before fanning out, so the org-config read happens on an
			// empty connection pool rather than queueing behind a sibling's warehouse
			// fetch. No-op on a warm memo.
			yield* warehouse.warmRoute(tenant)
			const joined = yield* Effect.all(
				{
					orphans: warehouse.compiledQuery(tenant, Integrations.auditOrphanSpansSQL(window), {
						profile: "aggregation",
						settings: { maxThreads: 4 },
						context: "setupAuditOrphanSpans",
					}),
					rootless: warehouse.compiledQuery(tenant, Integrations.auditRootlessTracesSQL(window), {
						profile: "aggregation",
						settings: { maxThreads: 4 },
						context: "setupAuditRootlessTraces",
					}),
				},
				{ concurrency: 2 },
			)

			const inputs: TraceCompletenessInputs = {
				windowMinutes: TRACE_WINDOW_MINUTES,
				traceSampleModulus: window.traceSampleModulus,
				orphans: joined.orphans,
				rootless: joined.rootless,
			}
			return inputs
		})

		/**
		 * Eight reads, seven of them over pre-aggregated rollups. Run concurrently but capped: the
		 * audit is a diagnostic endpoint and must never behave like a load generator against a
		 * warehouse that may already be struggling — which is often exactly why someone runs it.
		 */
		const fetchWarehouseInputs = Effect.fn("SetupAuditService.fetchWarehouseInputs")(function* (
			tenant: TenantContext,
		) {
			const now = yield* Clock.currentTimeMillis
			const window = {
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(now - LOOKBACK_HOURS * 60 * 60 * 1000),
				endTime: formatWarehouseDateTime(now),
			}
			const logWindow = {
				orgId: tenant.orgId,
				startTime: formatWarehouseDateTime(
					now - Integrations.AUDIT_LOG_CORRELATION_MAX_HOURS * 60 * 60 * 1000,
				),
				endTime: formatWarehouseDateTime(now),
			}

			const run = <A>(
				compiled: Parameters<typeof warehouse.compiledQuery<A>>[1],
				profile: "discovery" | "list",
			) => warehouse.compiledQuery(tenant, compiled, { profile, context: "setupAudit" })

			// Same reason as `fetchTraceCompleteness`. Both are independent entry
			// points, so each warms; whichever runs second finds the memo warm and
			// pays nothing.
			yield* warehouse.warmRoute(tenant)
			const results = yield* Effect.all(
				{
					usage: run(
						CH.compile(CH.serviceUsageQuery({}), window, { rowSchema: CH.serviceUsageRowSchema }),
						"discovery",
					),
					attributeKeys: run(
						CH.compile(Integrations.auditAttributeKeyInventoryQuery(), window, {
							rowSchema: Integrations.auditAttributeKeyInventoryRowSchema,
						}),
						"discovery",
					),
					// `list`, not `discovery`: an org whose span names carry IDs — the very thing NAME-02
					// detects — inflates traces_aggregates_hourly past a 5s budget.
					spanShape: run(
						CH.compile(Integrations.auditSpanShapeByServiceQuery(), window, {
							rowSchema: Integrations.auditSpanShapeRowSchema,
						}),
						"list",
					),
					logSeverity: run(
						CH.compile(Integrations.auditLogSeverityByServiceQuery(), window, {
							rowSchema: Integrations.auditLogSeverityRowSchema,
						}),
						"discovery",
					),
					metricLabels: run(
						CH.compile(Integrations.auditMetricLabelCardinalityQuery(), window, {
							rowSchema: Integrations.auditMetricLabelRowSchema,
						}),
						"discovery",
					),
					peerValues: run(
						CH.compile(Integrations.auditPeerValueInventoryQuery(), window, {
							rowSchema: Integrations.auditPeerValueRowSchema,
						}),
						"discovery",
					),
					dbEdges: run(
						CH.compile(Integrations.auditDbEdgeIdentityQuery(), window, {
							rowSchema: Integrations.auditDbEdgeRowSchema,
						}),
						"discovery",
					),
					logCorrelation: run(
						CH.compile(Integrations.auditLogCorrelationQuery(), logWindow, {
							rowSchema: Integrations.auditLogCorrelationRowSchema,
						}),
						"list",
					),
				},
				{ concurrency: 4 },
			)

			// Trace completeness is the audit's only cross-span join, so it runs after the cheap reads
			// and sizes its trace sampling from the volume they just reported. It degrades on its own:
			// a join that times out costs the three TRC checks, not the whole telemetry half.
			const totalSpans = results.spanShape.reduce((sum, row) => sum + row.weightedSpanCount, 0)
			const traceCompleteness = yield* fetchTraceCompleteness(tenant, now, totalSpans).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Setup audit trace-completeness checks skipped").pipe(
						Effect.annotateLogs({ cause }),
						Effect.as(undefined),
					),
				),
			)

			const inputs: WarehouseAuditInputs = {
				lookbackHours: LOOKBACK_HOURS,
				logCorrelationHours: Integrations.AUDIT_LOG_CORRELATION_MAX_HOURS,
				traceCompleteness,
				attributeKeys: results.attributeKeys.map((row) => ({
					scope: row.scope,
					key: row.attributeKey,
					usageCount: row.usageCount,
				})),
				serviceUsage: results.usage.map((row) => ({
					serviceName: row.serviceName,
					logCount: row.totalLogCount,
					traceCount: row.totalTraceCount,
					metricCount:
						row.totalSumMetricCount +
						row.totalGaugeMetricCount +
						row.totalHistogramMetricCount +
						row.totalExpHistogramMetricCount,
				})),
				spanShape: results.spanShape.map((row) => ({
					serviceName: row.serviceName,
					spanCount: row.weightedSpanCount,
					errorCount: row.weightedErrorCount,
					serverCount: row.serverCount,
					consumerCount: row.consumerCount,
					noEnvCount: row.noEnvCount,
					spanNameCount: row.spanNameCount,
					badStatusCodes: row.badStatusCodes,
					badSpanKinds: row.badSpanKinds,
				})),
				logSeverity: results.logSeverity,
				metricLabels: results.metricLabels.map((row) => ({
					attributeKey: row.attributeKey,
					valueCardinality: row.valueCardinality,
				})),
				peerValues: results.peerValues,
				dbEdges: results.dbEdges,
				logCorrelation: results.logCorrelation,
			}
			return inputs
		})

		const run = Effect.fn("SetupAuditService.run")(function* (tenant: TenantContext) {
			const config = yield* fetchConfigInputs(tenant.orgId)

			// A warehouse outage must not take the whole audit down — the configuration half is the
			// part that most often explains "why didn't anything page me", and it is always readable.
			// `catchCause` rather than `Effect.option` deliberately: a driver-level defect should
			// degrade this diagnostic endpoint to skipped checks, not 500 it.
			const warehouseInputs = yield* fetchWarehouseInputs(tenant).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Setup audit telemetry checks skipped — warehouse unavailable").pipe(
						Effect.annotateLogs({ cause }),
						Effect.as(undefined),
					),
				),
			)

			const now = yield* Clock.currentTimeMillis
			const report = runSetupAudit({ now, config, warehouse: warehouseInputs })

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"audit.dataStatus": report.dataStatus,
				"audit.warehouseAvailable": report.warehouseAvailable,
				"audit.critical": report.summary.critical,
				"audit.warn": report.summary.warn,
				"audit.info": report.summary.info,
				"audit.skip": report.summary.skip,
			})

			return report
		})

		return { run } satisfies SetupAuditServiceShape
	},
)

export class SetupAuditService extends Context.Service<SetupAuditService, SetupAuditServiceShape>()(
	"@maple/api/services/SetupAuditService",
	{ make },
) {
	static readonly layer = Layer.effect(this, make)
}
