/**
 * The alerting ticks and their cron routing, kept apart from the Worker shell
 * (`./worker.ts`) so the schedule and its concurrency groups can be
 * characterized without acquiring production drivers — and so the api layer
 * graph this file drags in is imported on the first fire, not at startup and
 * not in the deploy process, where the Worker's init also runs.
 */
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
	ErrorIssueWorkflowService,
	ErrorPolicyService,
	ErrorsService,
	EscalationService,
	FixVerificationTickService,
	HazelOAuthService,
	layerPg,
	NotificationDispatcher,
	IssueFixVerificationService,
	OrgClickHouseSettingsService,
	OrgIngestKeysService,
	OrgMembersService,
	PlanetScaleOAuthService,
	PullRequestLookupLive,
	PlanetScaleService,
	QueryEngineService,
	ServiceMapRollupService,
	TinybirdOrgTokenService,
	VcsSourceServiceLayer,
	WarehouseQueryService,
	summarizeCause,
	withPgConnectionScope,
} from "@maple/api/alerting"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { layerFromEnv, layerFromEnvRecord } from "@maple/infra/worker-runtime"
import { Cause, Effect, Layer, Match } from "effect"
import type { AlertingWorkerEnv } from "./worker.ts"

// Module-scope construction; `flush(env)` resolves env on first call. The
// in-isolate buffers coalesce concurrent scheduled ticks into one POST per
// signal. Exported for the shell, which drains it after each fire.
export const telemetry = MapleCloudflareSDK.make({
	serviceName: "alerting",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

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

	// Only reachable from here through an investigation agent's `propose_fix`, but
	// wired all the same: which worker served the call should not decide whether a
	// pull-request link arrives with its title and state, or whether attaching an
	// already-merged PR opens a verification window.
	const VcsSourceServiceLive = VcsSourceServiceLayer.pipe(Layer.provide(BaseLive))

	const IssueFixVerificationServiceLive = IssueFixVerificationService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				ErrorActorsServiceLive,
				ErrorIssueWorkflowServiceLive,
				PullRequestLookupLive.pipe(Layer.provide(VcsSourceServiceLive)),
			),
		),
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
				ErrorIssueWorkflowServiceLive,
				ErrorPolicyServiceLive,
				IssueFixVerificationServiceLive,
				WorkerEnvironmentLive,
			),
		),
	)

	// WorkerEnvironment merged in so the tick can reach the fan-out workflow
	// binding when it opens a verification investigation.
	const FixVerificationTickServiceLive = FixVerificationTickService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				WarehouseQueryServiceLive,
				IssueFixVerificationServiceLive,
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
		FixVerificationTickServiceLive,
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

const fixVerificationTick = makeTick(
	FixVerificationTickService.use((service) => service.runTick()),
	"fix_verification",
	(result) => ({
		examined: result.examined,
		refuted: result.refuted,
		investigationsStarted: result.investigationsStarted,
		verdictsApplied: result.verdictsApplied,
		skipped: result.skipped,
		failedRows: result.failedRows,
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
	readonly fixVerification: Effect.Effect<void, never, R>
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
			// `fixVerification` is chained onto `error` rather than listed beside it:
			// a window this minute's error tick just refuted must already be settled
			// when the verification tick looks at it, and array order under bounded
			// concurrency does not promise that — alert and escalation finishing
			// first would have started fixVerification while error still ran.
			Effect.all([ticks.alert, Effect.andThen(ticks.error, ticks.fixVerification), ticks.escalation], {
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
	| FixVerificationTickService
	| PlanetScaleService
	| ServiceMapRollupService

export const scheduledTicks: ScheduledTickPrograms<ScheduledServices> = {
	alert: alertTick,
	anomaly: anomalyTick,
	cloudflareAnalytics: cloudflareAnalyticsTick,
	digest: digestTick,
	error: errorTick,
	escalation: escalationTick,
	fixVerification: fixVerificationTick,
	planetScale: planetScaleTick,
	serviceMapRollup: serviceMapRollupTick,
}

/**
 * One cron fire: the tick group for `cron`, over the layer graph built from
 * this invocation's env and released when the fire completes — the same
 * build-per-fire the async entry did through `ManagedRuntime`. One Postgres
 * socket for the whole tick: alerting is ~97% of the workers' Postgres
 * traffic and a single anomaly tick was measured at 628 dials, each spending
 * one of the Worker's six outbound connection slots on a handshake; the
 * tick's statements now pipeline over one.
 */
export const runScheduled = (cron: string, env: AlertingWorkerEnv): Effect.Effect<void, unknown> =>
	withPgConnectionScope(selectScheduledProgram(cron, scheduledTicks)).pipe(
		// One fire is one application run: the layer is built here and released
		// with it, as the async entry's ManagedRuntime was.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(buildLayer(env)),
	)
