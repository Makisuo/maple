import {
	AlertRuntime,
	AlertsService,
	BucketCacheService,
	DatabaseD1Live,
	DigestService,
	EdgeCacheService,
	EmailService,
	Env,
	ErrorsService,
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
import {
	runScheduledEffect,
	WorkerConfigProviderLive,
	WorkerEnvironmentLive,
} from "@maple/effect-cloudflare"
import { Cause, Effect, Layer } from "effect"

// Module-scope construction; `flush(env)` resolves env on first call. The
// in-isolate buffers coalesce concurrent scheduled ticks into one POST per
// signal.
const telemetry = MapleCloudflareSDK.make({ serviceName: "alerting" })

const buildLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLive
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))

	const DatabaseLive = DatabaseD1Live.pipe(Layer.provide(WorkerEnvironmentLive))

	const BaseLive = Layer.mergeAll(EnvLive, DatabaseLive)

	const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(Layer.provide(BaseLive))

	const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, OrgClickHouseSettingsLive)),
	)

	const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provide(EdgeCacheService.layer))

	const QueryEngineServiceLive = QueryEngineService.layer.pipe(
		Layer.provide(WarehouseQueryServiceLive),
		Layer.provide(EdgeCacheService.layer),
		Layer.provide(BucketCacheServiceLive),
	)

	const HazelOAuthServiceLive = HazelOAuthService.layer.pipe(Layer.provide(BaseLive))

	const AlertsServiceLive = AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				QueryEngineServiceLive,
				WarehouseQueryServiceLive,
				AlertRuntime.layer,
				HazelOAuthServiceLive,
			),
		),
	)

	const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, HazelOAuthServiceLive)),
	)

	const ErrorsServiceLive = ErrorsService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive, NotificationDispatcherLive)),
	)

	const EmailServiceLive = EmailService.layer.pipe(Layer.provide(EnvLive))

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
		DigestServiceLive,
		OnboardingEmailServiceLive,
		ErrorsServiceLive,
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
		Effect.logError("Onboarding tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
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
		const program =
			event.cron === "*/15 * * * *"
				? digestTick
				: event.cron === "0 * * * *"
					? serviceMapRollupTick
					: event.cron === "0 9 * * *"
						? onboardingTick
						: Effect.all([alertTick, errorTick], { concurrency: 2, discard: true })
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
