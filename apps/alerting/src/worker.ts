import {
  AlertRuntime,
  AlertsService,
  DatabaseD1Live,
  DigestService,
  EdgeCacheService,
  EmailService,
  Env,
  ErrorsService,
  makeTelemetryLayer,
  NotificationDispatcher,
  OrgTinybirdSettingsService,
  QueryEngineService,
  TinybirdService,
  TinybirdSyncClient,
  WorkerEnvironment,
} from "@maple/api/alerting"
import { Cause, ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"

const buildLayer = (env: Record<string, unknown>) => {
  const ConfigLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
  const WorkerEnvLive = Layer.succeed(WorkerEnvironment, env)
  const EnvLive = Env.Default.pipe(Layer.provide(ConfigLive))

  const DatabaseLive = DatabaseD1Live.pipe(Layer.provide(WorkerEnvLive))

  const BaseLive = Layer.mergeAll(EnvLive, DatabaseLive)

  const TinybirdSyncClientLive = TinybirdSyncClient.Default

  const OrgTinybirdSettingsLive = OrgTinybirdSettingsService.Live.pipe(
    Layer.provide(Layer.mergeAll(BaseLive, TinybirdSyncClientLive)),
  )

  const TinybirdServiceLive = TinybirdService.Live.pipe(
    Layer.provide(Layer.mergeAll(EnvLive, OrgTinybirdSettingsLive)),
  )

  const QueryEngineServiceLive = QueryEngineService.layer.pipe(
    Layer.provide(TinybirdServiceLive),
    Layer.provide(EdgeCacheService.layer),
  )

  const AlertsServiceLive = AlertsService.Live.pipe(
    Layer.provide(
      Layer.mergeAll(BaseLive, QueryEngineServiceLive, TinybirdServiceLive, AlertRuntime.Default),
    ),
  )

  const NotificationDispatcherLive = NotificationDispatcher.Live.pipe(
    Layer.provide(BaseLive),
  )

  const ErrorsServiceLive = ErrorsService.Live.pipe(
    Layer.provide(
      Layer.mergeAll(BaseLive, TinybirdServiceLive, NotificationDispatcherLive),
    ),
  )

  const EmailServiceLive = EmailService.Default.pipe(Layer.provide(EnvLive))

  const DigestServiceLive = DigestService.Default.pipe(
    Layer.provide(Layer.mergeAll(BaseLive, TinybirdServiceLive, EmailServiceLive)),
  )

  const TelemetryLive = makeTelemetryLayer("alerting").pipe(
    Layer.provide(ConfigLive),
  )

  return Layer.mergeAll(AlertsServiceLive, DigestServiceLive, ErrorsServiceLive).pipe(
    Layer.provideMerge(TelemetryLive),
    Layer.provideMerge(ConfigLive),
  )
}

type AlertingRuntime = ReturnType<typeof buildAlertingRuntime>

const buildAlertingRuntime = (env: Record<string, unknown>) =>
  ManagedRuntime.make(buildLayer(env))

// Intentionally NOT cached across invocations. A cached runtime's scope never
// closes on CF Workers, which means OtlpExporter's `Scope.addFinalizer` (the
// only reliable flush path here — the background export-interval fiber does
// not progress between scheduled ticks) is never fired and telemetry silently
// piles up in the in-memory buffer. Building per-tick keeps layer construction
// cheap (closures, no real I/O) and lets us dispose the runtime in
// `ctx.waitUntil`, which triggers the finalizer → runExport → OTLP POST.
const makeRuntime = (env: Record<string, unknown>): AlertingRuntime =>
  ManagedRuntime.make(buildLayer(env)) as AlertingRuntime

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
    Effect.logError("Digest tick failed").pipe(
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
    const runtime = makeRuntime(env)
    const program =
      event.cron === "*/15 * * * *"
        ? digestTick
        : Effect.all([alertTick, errorTick], { concurrency: 2, discard: true })
    const done = runtime
      .runPromise(program)
      .finally(() =>
        runtime.dispose().catch((err) =>
          console.error("[telemetry] alerting runtime dispose failed:", err),
        ),
      )
    ctx.waitUntil(done)
    await done
  },
  fetch(_request: Request): Response {
    return new Response("maple-alerting: scheduled only", { status: 404 })
  },
}
