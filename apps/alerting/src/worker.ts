import {
	ANTICIPATED_ERROR_TAGS,
	AlertsService,
	AnomalyDetectionService,
	BucketCacheService,
	CacheBackendLive,
	DatabasePgLive,
	DigestService,
	EdgeCacheService,
	EmailService,
	Env,
	ErrorsService,
	EscalationService,
	HazelOAuthService,
	NotificationDispatcher,
	OnboardingEmailService,
	OnboardingService,
	OrgClickHouseSettingsService,
	QueryEngineService,
	ServiceMapRollupService,
	WarehouseQueryService,
} from "@maple/api/alerting"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { runScheduledEffect, WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Cause, Effect, Layer, Match } from "effect"

// Module-scope construction; `flush(env)` resolves env on first call. The
// in-isolate buffers coalesce concurrent scheduled ticks into one POST per
// signal.
const telemetry = MapleCloudflareSDK.make({
	serviceName: "alerting",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorTags: [...ANTICIPATED_ERROR_TAGS],
})

const buildLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))

	const DatabaseLive = DatabasePgLive.pipe(Layer.provide(WorkerEnvironment.layer))

	const BaseLive = Layer.mergeAll(EnvLive, DatabaseLive)

	const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(Layer.provide(BaseLive))

	const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, OrgClickHouseSettingsLive)),
	)

	// EdgeCacheService's storage backend is injected via the CacheBackend port.
	// Define the wired layer once so it memoizes to a single shared instance.
	const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))

	const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provide(EdgeCacheServiceLive))

	const QueryEngineServiceLive = QueryEngineService.layer.pipe(
		Layer.provide(WarehouseQueryServiceLive),
		Layer.provide(EdgeCacheServiceLive),
		Layer.provide(BucketCacheServiceLive),
	)

	const HazelOAuthServiceLive = HazelOAuthService.layer.pipe(Layer.provide(BaseLive))

	// WorkerEnvironment is merged in so the incident-open issue-hub hook can see
	// the cross-script AI_TRIAGE_WORKFLOW binding (absent → triage marked failed).
	// AlertRuntime is a Context.Reference with defaults, so it needs no wiring here.
	const AlertsServiceLive = AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				QueryEngineServiceLive,
				WarehouseQueryServiceLive,
				HazelOAuthServiceLive,
				WorkerEnvironment.layer,
			),
		),
	)

	const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, HazelOAuthServiceLive)),
	)

	const EscalationServiceLive = EscalationService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, NotificationDispatcherLive)),
	)

	// WorkerEnvironment is merged in so the incident-open AI-triage hook can see
	// the cross-script AI_TRIAGE_WORKFLOW binding (absent → triage marked failed).
	const ErrorsServiceLive = ErrorsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				WarehouseQueryServiceLive,
				EdgeCacheServiceLive,
				NotificationDispatcherLive,
				WorkerEnvironment.layer,
			),
		),
	)

	const AnomalyDetectionServiceLive = AnomalyDetectionService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				WarehouseQueryServiceLive,
				EdgeCacheServiceLive,
				WorkerEnvironment.layer,
			),
		),
	)

	// EmailService now resolves the Cloudflare Email Service `EMAIL` binding from
	// WorkerEnvironment (delivery binding) in addition to EnvLive (EMAIL_FROM).
	const EmailServiceLive = EmailService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, WorkerEnvironment.layer)),
	)

	const DigestServiceLive = DigestService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive, EmailServiceLive)),
	)

	const OnboardingServiceLive = OnboardingService.layer.pipe(Layer.provide(BaseLive))

	const OnboardingEmailServiceLive = OnboardingEmailService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(BaseLive, EmailServiceLive, OnboardingServiceLive, WarehouseQueryServiceLive),
		),
	)

	const ServiceMapRollupServiceLive = ServiceMapRollupService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive)),
	)

	return Layer.mergeAll(
		AlertsServiceLive,
		AnomalyDetectionServiceLive,
		DigestServiceLive,
		OnboardingEmailServiceLive,
		ErrorsServiceLive,
		EscalationServiceLive,
		ServiceMapRollupServiceLive,
	).pipe(Layer.provideMerge(telemetry.layer), Layer.provideMerge(ConfigLive))
}

const alertTick = Effect.gen(function* () {
	const alerts = yield* AlertsService
	const result = yield* alerts.runSchedulerTick()
	yield* Effect.logInfo("Alerting worker tick complete").pipe(
		Effect.annotateLogs({
			evaluatedCount: result.evaluatedCount,
			processedCount: result.processedCount,
			evaluationFailureCount: result.evaluationFailureCount,
			deliveryFailureCount: result.deliveryFailureCount,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.scheduler_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Alerting worker tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const errorTick = Effect.gen(function* () {
	const errors = yield* ErrorsService
	const result = yield* errors.runTick()
	yield* Effect.logInfo("Errors worker tick complete").pipe(
		Effect.annotateLogs({
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
}).pipe(
	Effect.withSpan("alerting.error_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Errors worker tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const escalationTick = Effect.gen(function* () {
	const escalations = yield* EscalationService
	const result = yield* escalations.runEscalationTick()
	if (result.processed > 0) {
		yield* Effect.logInfo("Escalation tick complete").pipe(
			Effect.annotateLogs({
				processed: result.processed,
				sent: result.sent,
				skipped: result.skipped,
				failed: result.failed,
				retried: result.retried,
			}),
		)
	}
}).pipe(
	Effect.withSpan("alerting.escalation_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Escalation tick failed").pipe(Effect.annotateLogs({ error: Cause.pretty(cause) })),
	),
)

const digestTick = Effect.gen(function* () {
	const digest = yield* DigestService
	const result = yield* digest.runDigestTick()
	yield* Effect.logInfo("Digest tick complete").pipe(
		Effect.annotateLogs({
			sentCount: result.sentCount,
			errorCount: result.errorCount,
			skipped: result.skipped,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.digest_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Digest tick failed").pipe(Effect.annotateLogs({ error: Cause.pretty(cause) })),
	),
)

const onboardingTick = Effect.gen(function* () {
	const onboardingEmails = yield* OnboardingEmailService
	const result = yield* onboardingEmails.runOnboardingTick()
	yield* Effect.logInfo("Onboarding tick complete").pipe(
		Effect.annotateLogs({
			ensuredCount: result.ensuredCount,
			sentCount: result.sentCount,
			errorCount: result.errorCount,
			firstDataDetected: result.firstDataDetected,
			skipped: result.skipped,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.onboarding_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Onboarding tick failed").pipe(Effect.annotateLogs({ error: Cause.pretty(cause) })),
	),
)

const serviceMapRollupTick = Effect.gen(function* () {
	const rollup = yield* ServiceMapRollupService
	const result = yield* rollup.runRollupTick()
	yield* Effect.logInfo("Service map rollup tick complete").pipe(
		Effect.annotateLogs({
			orgsProcessed: result.orgsProcessed,
			hoursRolledUp: result.hoursRolledUp,
			edgesWritten: result.edgesWritten,
			orgFailures: result.orgFailures,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.service_map_rollup_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Service map rollup tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const anomalyTick = Effect.gen(function* () {
	const anomalies = yield* AnomalyDetectionService
	const result = yield* anomalies.runTick()
	yield* Effect.logInfo("Anomaly detection tick complete").pipe(
		Effect.annotateLogs({
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
}).pipe(
	Effect.withSpan("alerting.anomaly_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Anomaly detection tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

interface ScheduledEventLike {
	readonly cron: string
}

interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void
}

export default {
	async scheduled(
		event: ScheduledEventLike,
		env: Record<string, unknown>,
		ctx: ExecutionContextLike,
	): Promise<void> {
		const program = Match.value(event.cron).pipe(
			Match.when("*/5 * * * *", () => anomalyTick),
			Match.when("*/15 * * * *", () => digestTick),
			Match.when("0 * * * *", () => serviceMapRollupTick),
			Match.when("0 9 * * *", () => onboardingTick),
			Match.orElse(() =>
				Effect.all([alertTick, errorTick, escalationTick], {
					concurrency: 2,
					discard: true,
				}),
			),
		)
		try {
			await runScheduledEffect(buildLayer(env), program, ctx)
		} finally {
			ctx.waitUntil(telemetry.flush(env))
		}
	},
	fetch(_request: Request): Response {
		return new Response("maple-alerting: scheduled only", { status: 404 })
	},
}
