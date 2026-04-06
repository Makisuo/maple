import { BunRuntime } from "@effect/platform-bun"
import { AlertRuntime, AlertsService, Database, DigestService, EmailService, Env, makeTelemetryLayer, OrgTinybirdSettingsService, QueryEngineService, TinybirdService } from "@maple/api/alerting"
import { Cause, Duration, Effect, Layer, Schedule } from "effect"

const DatabaseLive = Database.Default.pipe(
  Layer.provide(Env.Default),
)

const BaseLive = Layer.mergeAll(
  Env.Default,
  DatabaseLive,
)

const OrgTinybirdSettingsLive = OrgTinybirdSettingsService.Live.pipe(
  Layer.provide(BaseLive),
)

const TinybirdDependenciesLive = Layer.mergeAll(
  Env.Default,
  OrgTinybirdSettingsLive,
)

const TinybirdServiceLive = TinybirdService.Live.pipe(
  Layer.provide(TinybirdDependenciesLive),
)

const QueryEngineServiceLive = QueryEngineService.layer.pipe(
  Layer.provide(TinybirdServiceLive),
)

const AlertsDependenciesLive = Layer.mergeAll(
  BaseLive,
  QueryEngineServiceLive,
  AlertRuntime.Default,
)

const AlertsServiceLive = AlertsService.Live.pipe(
  Layer.provide(AlertsDependenciesLive),
)

const EmailServiceLive = EmailService.Default.pipe(
  Layer.provide(Env.Default),
)

const DigestDependenciesLive = Layer.mergeAll(
  BaseLive,
  TinybirdServiceLive,
  EmailServiceLive,
)

const DigestServiceLive = DigestService.Default.pipe(
  Layer.provide(DigestDependenciesLive),
)

const TelemetryLive = makeTelemetryLayer("alerting")

const alertLoop = Effect.gen(function* () {
  const alerts = yield* AlertsService

  yield* alerts.runSchedulerTick().pipe(
    Effect.tap((result) =>
      Effect.logInfo("Alerting worker tick complete").pipe(
        Effect.annotateLogs({
          evaluatedCount: result.evaluatedCount,
          processedCount: result.processedCount,
          evaluationFailureCount: result.evaluationFailureCount,
          deliveryFailureCount: result.deliveryFailureCount,
        }),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("Alerting worker tick failed").pipe(
        Effect.annotateLogs({ error: Cause.pretty(cause) }),
      ),
    ),
    Effect.repeat(
      Schedule.spaced(Duration.seconds(60)).pipe(
        Schedule.jittered,
      ),
    ),
  )
})

const digestLoop = Effect.gen(function* () {
  const digest = yield* DigestService

  yield* digest.runDigestTick().pipe(
    Effect.tap((result) =>
      Effect.logInfo("Digest tick complete").pipe(
        Effect.annotateLogs({
          sentCount: result.sentCount,
          errorCount: result.errorCount,
          skipped: result.skipped,
        }),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("Digest tick failed").pipe(
        Effect.annotateLogs({ error: Cause.pretty(cause) }),
      ),
    ),
    Effect.repeat(
      Schedule.spaced(Duration.minutes(15)).pipe(
        Schedule.jittered,
      ),
    ),
  )
})

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Alerting worker started")

  // Run digest loop detached, alert loop in foreground
  yield* digestLoop.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Digest loop terminated unexpectedly").pipe(
        Effect.annotateLogs({ error: Cause.pretty(cause) }),
      ),
    ),
    Effect.forkDetach,
  )
  yield* alertLoop
}).pipe(
  Effect.provide(
    Layer.mergeAll(AlertsServiceLive, DigestServiceLive).pipe(
      Layer.provide(TelemetryLive),
    ),
  ),
)

BunRuntime.runMain(program)
