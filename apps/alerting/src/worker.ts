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
	OrgClickHouseSettingsService,
	QueryEngineService,
	TinybirdService,
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
	const EnvLive = Env.Default.pipe(Layer.provide(ConfigLive))

	const DatabaseLive = DatabaseD1Live.pipe(Layer.provide(WorkerEnvironmentLive))

	const BaseLive = Layer.mergeAll(EnvLive, DatabaseLive)

	const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.Live.pipe(Layer.provide(BaseLive))

	const TinybirdServiceLive = TinybirdService.Live.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, OrgClickHouseSettingsLive)),
	)

	const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provide(EdgeCacheService.layer))

	const QueryEngineServiceLive = QueryEngineService.layer.pipe(
		Layer.provide(TinybirdServiceLive),
		Layer.provide(EdgeCacheService.layer),
		Layer.provide(BucketCacheServiceLive),
	)

	const HazelOAuthServiceLive = HazelOAuthService.Live.pipe(Layer.provide(BaseLive))

	const AlertsServiceLive = AlertsService.Live.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				QueryEngineServiceLive,
				TinybirdServiceLive,
				AlertRuntime.Default,
				HazelOAuthServiceLive,
			),
		),
	)

	const NotificationDispatcherLive = NotificationDispatcher.Live.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, HazelOAuthServiceLive)),
	)

	const ErrorsServiceLive = ErrorsService.Live.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, TinybirdServiceLive, NotificationDispatcherLive)),
	)

	const EmailServiceLive = EmailService.Default.pipe(Layer.provide(EnvLive))

	const DigestServiceLive = DigestService.Default.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, TinybirdServiceLive, EmailServiceLive)),
	)

	return Layer.mergeAll(AlertsServiceLive, DigestServiceLive, ErrorsServiceLive).pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(ConfigLive),
	)
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
