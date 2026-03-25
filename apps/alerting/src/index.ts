import { BunRuntime } from "@effect/platform-bun"
import { AlertRuntime, AlertsService, Database, Env, OrgTinybirdSettingsService, QueryEngineService, TinybirdService } from "@maple/api/alerting"
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

const program = Effect.gen(function* () {
  const alerts = yield* AlertsService

  yield* Effect.logInfo("Alerting worker started")

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
}).pipe(
  Effect.provide(AlertsServiceLive),
)

BunRuntime.runMain(program)
