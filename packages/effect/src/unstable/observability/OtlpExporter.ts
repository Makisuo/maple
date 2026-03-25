/**
 * @since 4.0.0
 */
import { Clock } from "../../Clock.ts"
import * as Duration from "../../Duration.ts"
import * as Effect from "../../Effect.ts"
import * as Fiber from "../../Fiber.ts"
import * as Num from "../../Number.ts"
import * as Option from "../../Option.ts"
import * as Schedule from "../../Schedule.ts"
import * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Headers from "../../unstable/http/Headers.ts"
import * as HttpClient from "../../unstable/http/HttpClient.ts"
import * as HttpClientError from "../../unstable/http/HttpClientError.ts"
import * as HttpClientRequest from "../../unstable/http/HttpClientRequest.ts"
import type { HttpBody } from "../http/HttpBody.ts"

const policy = Schedule.forever.pipe(
  Schedule.passthrough,
  Schedule.addDelay((error) => {
    if (
      HttpClientError.isHttpClientError(error)
      && error.reason._tag === "StatusCodeError"
      && error.reason.response.status === 429
    ) {
      const retryAfter = Option.fromUndefinedOr(error.reason.response.headers["retry-after"]).pipe(
        Option.flatMap(Num.parse),
        Option.getOrElse(() => 5)
      )
      return Effect.succeed(Duration.seconds(retryAfter))
    }
    return Effect.succeed(Duration.seconds(1))
  })
)

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make: (
  options: {
    readonly url: string
    readonly headers: Headers.Input | undefined
    readonly label: string
    readonly exportInterval: Duration.Input
    readonly maxBatchSize: number | "disabled"
    readonly body: (data: Array<any>) => HttpBody
    readonly shutdownTimeout: Duration.Input
  }
) => Effect.Effect<
  { readonly push: (data: unknown) => void },
  never,
  HttpClient.HttpClient | Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const services = yield* Effect.services<Scope.Scope | HttpClient.HttpClient>()
  const clock = ServiceMap.get(services, Clock)
  const scope = ServiceMap.get(services, Scope.Scope)
  const runFork = Effect.runForkWith(services)
  const exportInterval = Duration.max(Duration.fromInputUnsafe(options.exportInterval), Duration.zero)
  let disabledUntil: number | undefined = undefined

  const client = HttpClient.filterStatusOk(ServiceMap.get(services, HttpClient.HttpClient)).pipe(
    HttpClient.retryTransient({ schedule: policy, times: 3 })
  )

  let headers = Headers.fromRecordUnsafe({
    "user-agent": `effect-opentelemetry-${options.label}/0.0.0`
  })
  if (options.headers) {
    headers = Headers.merge(Headers.fromInput(options.headers), headers)
  }

  const request = HttpClientRequest.post(options.url, { headers })
  let buffer: Array<any> = []
  const runExport = Effect.suspend(() => {
    if (disabledUntil !== undefined && clock.currentTimeMillisUnsafe() < disabledUntil) {
      return Effect.void
    } else if (disabledUntil !== undefined) {
      disabledUntil = undefined
    }
    const items = buffer
    if (options.maxBatchSize !== "disabled") {
      if (buffer.length === 0) {
        return Effect.void
      }
      buffer = []
    }
    return client.execute(
      HttpClientRequest.setBody(request, options.body(items))
    ).pipe(
      Effect.asVoid,
      Effect.withTracerEnabled(false)
    )
  }).pipe(
    Effect.catchCause((cause) => {
      if (disabledUntil !== undefined) return Effect.void
      disabledUntil = clock.currentTimeMillisUnsafe() + 60_000
      buffer = []
      return Effect.logDebug("Disabling exporter for 60 seconds", cause)
    }),
    Effect.annotateLogs({
      package: "@effect/opentelemetry",
      module: options.label
    })
  )

  yield* Scope.addFinalizer(
    scope,
    runExport.pipe(
      Effect.ignore,
      Effect.interruptible,
      Effect.timeoutOption(options.shutdownTimeout)
    )
  )

  yield* Effect.sleep(exportInterval).pipe(
    Effect.andThen(runExport),
    Effect.forever,
    Effect.forkIn(scope)
  )

  return {
    push(data) {
      if (disabledUntil !== undefined) return
      buffer.push(data)
      if (options.maxBatchSize !== "disabled" && buffer.length >= options.maxBatchSize) {
        Fiber.runIn(runFork(runExport), scope)
      }
    }
  }
})
