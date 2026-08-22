import {
	ANTICIPATED_ERROR_IDENTIFIERS,
	AlertDestinationsService,
	AlertReadModelsService,
	AlertRuntime,
	AlertRulesService,
	AlertsService,
	AnomalyDetectionService,
	BucketCacheService,
	CacheBackendLive,
	CloudflareAnalyticsService,
	CloudflareOAuthService,
	DigestService,
	EdgeCacheService,
	EmailService,
	Env,
	ErrorActorsService,
	ErrorIssueReadModelsService,
	ErrorIssueWorkflowService,
	ErrorPolicyService,
	ErrorsService,
	EscalationService,
	HazelOAuthService,
	layerPg,
	NotificationDispatcher,
	OrgClickHouseSettingsService,
	OrgIngestKeysService,
	OrgMembersService,
	PlanetScaleOAuthService,
	PlanetScaleService,
	QueryEngineService,
	ServiceMapRollupService,
	TinybirdOrgTokenService,
	WarehouseQueryService,
	summarizeCause,
	withPgConnectionScope,
} from "@maple/api/alerting"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { layerFromEnv, layerFromEnvRecord, runScheduledEffect } from "@maple/effect-cloudflare"
import { Cause, Effect, Layer, Match } from "effect"

// Module-scope construction; `flush(env)` resolves env on first call. The
// in-isolate buffers coalesce concurrent scheduled ticks into one POST per
// signal.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "alerting",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

interface AlertingWorkerEnv {
	readonly [key: string]: unknown
}

export const buildLayer = (env: AlertingWorkerEnv) => {
	// Keep config and binding services on the same invocation-scoped env record;
	// scheduled handlers already receive the authoritative Cloudflare bindings.
	const ConfigLive = layerFromEnv(env)
	const WorkerEnvironmentLive = layerFromEnvRecord(env)
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))

	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironmentLive))

	const BaseLive = Layer.mergeAll(EnvLive, DatabaseLive)
	const AlertRuntimeLive = AlertRuntime.layer
	const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))

	const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, EdgeCacheServiceLive)),
	)

	const TinybirdOrgTokenLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(EnvLive))

	const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, OrgClickHouseSettingsLive, TinybirdOrgTokenLive)),
	)

	const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provide(EdgeCacheServiceLive))

	const QueryEngineServiceLive = QueryEngineService.layer.pipe(
		Layer.provide(WarehouseQueryServiceLive),
		Layer.provide(EdgeCacheServiceLive),
		Layer.provide(BucketCacheServiceLive),
	)

	const HazelOAuthServiceLive = HazelOAuthService.layer.pipe(Layer.provide(BaseLive))

	// EmailService resolves the Cloudflare Email Service `EMAIL` binding from
	// WorkerEnvironment (delivery binding) in addition to EnvLive (EMAIL_FROM).
	const EmailServiceLive = EmailService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, WorkerEnvironmentLive)),
	)

	const OrgMembersServiceLive = OrgMembersService.layer.pipe(Layer.provide(EnvLive))

	const AlertDestinationsServiceLive = AlertDestinationsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(BaseLive, HazelOAuthServiceLive, EmailServiceLive, OrgMembersServiceLive),
		),
	)

	const AlertReadModelsServiceLive = AlertReadModelsService.layer.pipe(
		Layer.provide(Layer.mergeAll(DatabaseLive, WarehouseQueryServiceLive)),
	)

	const AlertRulesServiceLive = AlertRulesService.layer.pipe(
		Layer.provide(Layer.mergeAll(DatabaseLive, AlertRuntimeLive)),
	)

	// WorkerEnvironment is merged in so the incident-open issue-hub hook can see
	// the cross-script investigation workflow binding. The hoisted AlertRuntime
	// layer is shared with the narrow rules capability even though the reference
	// also has production defaults.
	const AlertsServiceLive = AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				QueryEngineServiceLive,
				WarehouseQueryServiceLive,
				OrgClickHouseSettingsLive,
				AlertRuntimeLive,
				HazelOAuthServiceLive,
				EmailServiceLive,
				AlertDestinationsServiceLive,
				AlertReadModelsServiceLive,
				AlertRulesServiceLive,
				WorkerEnvironmentLive,
			),
		),
	)

	const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, HazelOAuthServiceLive, EmailServiceLive)),
	)

	const EscalationServiceLive = EscalationService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, NotificationDispatcherLive)),
	)

	const ErrorActorsServiceLive = ErrorActorsService.layer.pipe(Layer.provide(BaseLive))
	const ErrorIssueWorkflowServiceLive = ErrorIssueWorkflowService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, ErrorActorsServiceLive)),
	)
	const ErrorPolicyServiceLive = ErrorPolicyService.layer.pipe(Layer.provide(BaseLive))
	const ErrorIssueReadModelsServiceLive = ErrorIssueReadModelsService.layer.pipe(
		Layer.provide(Layer.mergeAll(DatabaseLive, WarehouseQueryServiceLive, ErrorIssueWorkflowServiceLive)),
	)

	// WorkerEnvironment is merged in so incident-open investigations can see the
	// cross-script fan-out workflow binding.
	const ErrorsServiceLive = ErrorsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				WarehouseQueryServiceLive,
				EdgeCacheServiceLive,
				NotificationDispatcherLive,
				ErrorActorsServiceLive,
				ErrorIssueReadModelsServiceLive,
				ErrorIssueWorkflowServiceLive,
				ErrorPolicyServiceLive,
				WorkerEnvironmentLive,
			),
		),
	)

	const AnomalyDetectionServiceLive = AnomalyDetectionService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(BaseLive, WarehouseQueryServiceLive, EdgeCacheServiceLive, WorkerEnvironmentLive),
		),
	)

	const DigestServiceLive = DigestService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(BaseLive, WarehouseQueryServiceLive, EdgeCacheServiceLive, EmailServiceLive),
		),
	)

	const ServiceMapRollupServiceLive = ServiceMapRollupService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive)),
	)

	const CloudflareOAuthServiceLive = CloudflareOAuthService.layer.pipe(Layer.provide(BaseLive))

	const OrgIngestKeysServiceLive = OrgIngestKeysService.layer.pipe(Layer.provide(BaseLive))

	const CloudflareAnalyticsServiceLive = CloudflareAnalyticsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				WarehouseQueryServiceLive,
				CloudflareOAuthServiceLive,
				OrgIngestKeysServiceLive,
				OrgClickHouseSettingsLive,
			),
		),
	)

	const PlanetScaleOAuthServiceLive = PlanetScaleOAuthService.layer.pipe(Layer.provide(BaseLive))

	const PlanetScaleServiceLive = PlanetScaleService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, PlanetScaleOAuthServiceLive)),
	)

	return Layer.mergeAll(
		AlertsServiceLive,
		AnomalyDetectionServiceLive,
		CloudflareAnalyticsServiceLive,
		PlanetScaleServiceLive,
		DigestServiceLive,
		ErrorsServiceLive,
		EscalationServiceLive,
		ServiceMapRollupServiceLive,
		// Exposed in the output, not just provided inward: `withPgConnectionScope`
		// resolves the `MAPLE_DB` binding from it when it opens the tick's socket.
		WorkerEnvironmentLive,
	).pipe(Layer.provideMerge(telemetry.layer), Layer.provideMerge(ConfigLive))
}

/**
 * Standard tick failure isolation. A broken tick must not fail the whole scheduled
 * invocation (several ticks share one cron dispatch), so genuine failures are logged and
 * swallowed — but interrupt-only causes (isolate teardown) are re-raised so they reach
 * `runScheduledEffect`'s `onInterrupt: "graceful"` handling instead of logging a phantom
 * tick failure. Mirrors the per-org guards inside the tick services.
 */
export const catchTickFailure = (label: string) =>
	Effect.catchCause((cause: Cause.Cause<unknown>) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.logError("Alerting tick failed").pipe(
					Effect.annotateLogs({
						"error.message": summarizeCause(cause),
						"maple.alerting.tick": label,
					}),
				),
	)

interface TickAnnotations {
	readonly [key: string]: unknown
}

const makeTick = <A, E, R>(
	run: Effect.Effect<A, E, R>,
	spanKey: string,
	annotationsFor: (result: A) => TickAnnotations | undefined,
): Effect.Effect<void, never, R> =>
	run.pipe(
		Effect.tap((result) => {
			const annotations = annotationsFor(result)
			const namespacedAnnotations =
				annotations === undefined
					? undefined
					: Object.fromEntries(
							Object.entries(annotations).map(([key, value]) => [
								`maple.alerting.${key}`,
								value,
							]),
						)
			return namespacedAnnotations === undefined
				? Effect.void
				: Effect.logInfo("Alerting tick completed").pipe(
						Effect.annotateLogs({ ...namespacedAnnotations, "maple.alerting.tick": spanKey }),
					)
		}),
		Effect.asVoid,
		Effect.withSpan(`alerting.${spanKey}_tick`),
		catchTickFailure(spanKey),
	)

const alertTick = makeTick(
	AlertsService.use((alerts) => alerts.runSchedulerTick()),
	"scheduler",
	(result) => ({
		evaluatedCount: result.evaluatedCount,
		processedCount: result.processedCount,
		evaluationFailureCount: result.evaluationFailureCount,
		deliveryFailureCount: result.deliveryFailureCount,
	}),
)

const errorTick = makeTick(
	ErrorsService.use((errors) => errors.runTick()),
	"error",
	(result) => ({
		orgsProcessed: result.orgsProcessed,
		issuesTouched: result.issuesTouched,
		incidentsOpened: result.incidentsOpened,
		incidentsResolved: result.incidentsResolved,
		issuesReopened: result.issuesReopened,
		issuesArchived: result.issuesArchived,
		issuesDeleted: result.issuesDeleted,
		retentionRan: result.retentionRan,
	}),
)

const escalationTick = makeTick(
	EscalationService.use((escalations) => escalations.runEscalationTick()),
	"escalation",
	(result) =>
		result.processed > 0
			? {
					processed: result.processed,
					sent: result.sent,
					skipped: result.skipped,
					failed: result.failed,
					retried: result.retried,
				}
			: undefined,
)

const digestTick = makeTick(
	DigestService.use((digest) => digest.runDigestTick()),
	"digest",
	(result) => ({
		sentCount: result.sentCount,
		errorCount: result.errorCount,
		skipped: result.skipped,
	}),
)

// The onboarding drip moved to maple-portal (`camp_onboarding`), which owns the
// sequence, its send log and its suppression list. `org_onboarding_state` stays
// here — the in-app checklist still uses the rest of that table — and so do its
// four `*_email_sent_at` columns, which are what the portal's backfill reads.

const serviceMapRollupTick = makeTick(
	ServiceMapRollupService.use((rollup) => rollup.runRollupTick()),
	"service_map_rollup",
	(result) => ({
		orgsProcessed: result.orgsProcessed,
		hoursRolledUp: result.hoursRolledUp,
		edgesWritten: result.edgesWritten,
		resolutionsWritten: result.resolutionsWritten,
		resolutionHoursChecked: result.resolutionHoursChecked,
		emptyResolutionHours: result.emptyResolutionHours,
		orgFailures: result.orgFailures,
	}),
)

const anomalyTick = makeTick(
	AnomalyDetectionService.use((anomalies) => anomalies.runTick()),
	"anomaly",
	(result) => ({
		orgsProcessed: result.orgsProcessed,
		seriesEvaluated: result.seriesEvaluated,
		incidentsOpened: result.incidentsOpened,
		incidentsAttached: result.incidentsAttached,
		incidentsReopened: result.incidentsReopened,
		incidentsContinued: result.incidentsContinued,
		incidentsResolved: result.incidentsResolved,
		orgFailures: result.orgFailures,
	}),
)

const cloudflareAnalyticsTick = makeTick(
	CloudflareAnalyticsService.use((analytics) => analytics.pollAllOrgs()),
	"cloudflare_analytics",
	(result) => ({
		orgs: result.orgs,
		rowsIngested: result.rowsIngested,
		skipped: result.skipped,
		failures: result.failures,
		perOrg: result.perOrg,
	}),
)

const planetScaleTick = makeTick(
	PlanetScaleService.use((planetscale) => planetscale.pollAllOrgs()),
	"planetscale",
	(result) =>
		result.orgs > 0
			? {
					orgs: result.orgs,
					refreshed: result.refreshed,
					skipped: result.skipped,
					failures: result.failures,
					deployEvents: result.deployEvents,
				}
			: undefined,
)

export interface ScheduledTickPrograms<R = never> {
	readonly alert: Effect.Effect<void, never, R>
	readonly anomaly: Effect.Effect<void, never, R>
	readonly cloudflareAnalytics: Effect.Effect<void, never, R>
	readonly digest: Effect.Effect<void, never, R>
	readonly error: Effect.Effect<void, never, R>
	readonly escalation: Effect.Effect<void, never, R>
	readonly planetScale: Effect.Effect<void, never, R>
	readonly serviceMapRollup: Effect.Effect<void, never, R>
}

/**
 * Keep cron routing separate from the Worker shell so the schedule and its
 * concurrency groups can be characterized without acquiring production
 * drivers. The concrete tick Effects remain module-scoped and unchanged.
 */
export const selectScheduledProgram = <R>(
	cron: string,
	ticks: ScheduledTickPrograms<R>,
): Effect.Effect<void, never, R> =>
	Match.value(cron).pipe(
		Match.when("*/5 * * * *", () =>
			Effect.all([ticks.anomaly, ticks.cloudflareAnalytics, ticks.planetScale], {
				concurrency: 3,
				discard: true,
			}),
		),
		Match.when("*/15 * * * *", () => ticks.digest),
		Match.when("0 * * * *", () => ticks.serviceMapRollup),
		Match.when("* * * * *", () =>
			Effect.all([ticks.alert, ticks.error, ticks.escalation], {
				concurrency: 2,
				discard: true,
			}),
		),
		// Fail closed: a newly configured cron must not silently inherit the
		// every-minute alert/error/escalation fan-out.
		Match.orElse((unknownCron) =>
			Effect.logWarning("Skipping unknown alerting cron schedule").pipe(
				Effect.annotateLogs({ cron: unknownCron }),
			),
		),
	)

type ScheduledServices =
	| AlertsService
	| AnomalyDetectionService
	| CloudflareAnalyticsService
	| DigestService
	| ErrorsService
	| EscalationService
	| PlanetScaleService
	| ServiceMapRollupService

const scheduledTicks: ScheduledTickPrograms<ScheduledServices> = {
	alert: alertTick,
	anomaly: anomalyTick,
	cloudflareAnalytics: cloudflareAnalyticsTick,
	digest: digestTick,
	error: errorTick,
	escalation: escalationTick,
	planetScale: planetScaleTick,
	serviceMapRollup: serviceMapRollupTick,
}

interface ScheduledEventLike {
	readonly cron: string
}

interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void
}

export default {
	async scheduled(
		event: ScheduledEventLike,
		env: AlertingWorkerEnv,
		ctx: ExecutionContextLike,
	): Promise<void> {
		// Non-prod stages (stg, PR previews) share live org data — stg's Hyperdrive
		// points at the prod database — so their crons would iterate real orgs with
		// stage-local Tinybird/Clerk credentials: every tick fails per-org and floods
		// the error dashboards (and historically sent duplicate emails, see #237).
		// Same gating philosophy as the prd-only EMAIL binding, with an explicit
		// override for deliberately exercising crons on a non-prod stage.
		const environment = typeof env.MAPLE_ENVIRONMENT === "string" ? env.MAPLE_ENVIRONMENT : ""
		const allowNonProd =
			env.MAPLE_ALERTING_ALLOW_NONPROD === "1" || env.MAPLE_ALERTING_ALLOW_NONPROD === "true"
		if (environment !== "production" && !allowNonProd) {
			console.log(
				`Skipping alerting cron on non-production stage (MAPLE_ENVIRONMENT=${environment || "unset"}, cron=${event.cron}); set MAPLE_ALERTING_ALLOW_NONPROD=1 to run crons here`,
			)
			return
		}
		const program = selectScheduledProgram(event.cron, scheduledTicks)
		try {
			// Cron ticks cancel gracefully on isolate teardown — the schedule reruns
			// anyway, and re-raised interrupts (see the per-org catchCause guards in the
			// tick services) must not surface as failed invocations.
			// One Postgres socket for the whole tick. Alerting is ~97% of the
			// workers' Postgres traffic and a single anomaly tick was measured at
			// 628 dials, each spending one of the Worker's six outbound connection
			// slots on a handshake; the tick's statements now pipeline over one.
			await runScheduledEffect(buildLayer(env), withPgConnectionScope(program), ctx, {
				onInterrupt: "graceful",
			})
		} finally {
			ctx.waitUntil(telemetry.flush(env))
		}
	},
	fetch(_request: Request): Response {
		return new Response("maple-alerting: scheduled only", { status: 404 })
	},
}
