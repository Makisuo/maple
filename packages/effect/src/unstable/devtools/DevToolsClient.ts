/**
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Deferred from "../../Deferred.ts"
import * as Effect from "../../Effect.ts"
import * as Fiber from "../../Fiber.ts"
import * as Layer from "../../Layer.ts"
import * as Metric from "../../Metric.ts"
import * as Queue from "../../Queue.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import * as Stream from "../../Stream.ts"
import * as Tracer from "../../Tracer.ts"
import * as Ndjson from "../encoding/Ndjson.ts"
import * as Socket from "../socket/Socket.ts"
import * as DevToolsSchema from "./DevToolsSchema.ts"

const RequestSchema = Schema.toCodecJson(DevToolsSchema.Request)
const ResponseSchema = Schema.toCodecJson(DevToolsSchema.Response)

/**
 * @since 4.0.0
 * @category tags
 */
export class DevToolsClient extends ServiceMap.Service<
  DevToolsClient,
  {
    readonly sendUnsafe: (
      _: DevToolsSchema.Span | DevToolsSchema.SpanEvent
    ) => void
  }
>()("effect/devtools/DevToolsClient") {}

const makeEffect = Effect.gen(function*() {
  const socket = yield* Socket.Socket
  const services = yield* Effect.services<never>()
  const requests = yield* Queue.unbounded<DevToolsSchema.Request>()
  const connected = yield* Deferred.make<void>()

  const offerMetricsSnapshot = Effect.sync(() => {
    Queue.offerUnsafe(requests, toMetricsSnapshot(services))
  })

  const handleResponse = (
    response: DevToolsSchema.Response
  ): Effect.Effect<void> => {
    switch (response._tag) {
      case "MetricsRequest": {
        return offerMetricsSnapshot
      }
      case "Pong": {
        return Effect.void
      }
    }
  }

  const fiber = yield* Stream.fromQueue(requests).pipe(
    Stream.pipeThroughChannel(
      Ndjson.duplexSchemaString(Socket.toChannelString(socket), {
        inputSchema: RequestSchema,
        outputSchema: ResponseSchema
      })
    ),
    Stream.onFirst(() => Deferred.completeWith(connected, Effect.void)),
    Stream.runForEach(handleResponse),
    Effect.forkDetach
  )

  yield* Effect.addFinalizer(() =>
    offerMetricsSnapshot.pipe(
      Effect.andThen(
        Effect.flatMap(Effect.fiberId, (id) => Queue.failCause(requests, Cause.interrupt(id)))
      ),
      Effect.andThen(Fiber.await(fiber))
    )
  )

  yield* Effect.suspend(() => Queue.offer(requests, { _tag: "Ping" })).pipe(
    Effect.delay("3 seconds"),
    Effect.forever,
    Effect.forkScoped
  )

  yield* Deferred.await(connected).pipe(
    Effect.timeoutOption("1 second"),
    Effect.asVoid
  )

  return DevToolsClient.of({
    sendUnsafe(request: DevToolsSchema.Span | DevToolsSchema.SpanEvent) {
      Queue.offerUnsafe(requests, request)
    }
  })
})

const toMetricsSnapshot = (
  services: ServiceMap.ServiceMap<never>
): DevToolsSchema.MetricsSnapshot => ({
  _tag: "MetricsSnapshot",
  metrics: Metric.snapshotUnsafe(services)
})

/**
 * @since 4.0.0
 * @category constructors
 */
export const make: Effect.Effect<
  DevToolsClient["Service"],
  never,
  Scope.Scope | Socket.Socket
> = makeEffect.pipe(
  Effect.annotateLogs({
    module: "DevTools",
    service: "Client"
  })
)

/**
 * @since 4.0.0
 * @category layers
 */
export const layer: Layer.Layer<DevToolsClient, never, Socket.Socket> = Layer.effect(DevToolsClient, make)

const makeTracerEffect = Effect.gen(function*() {
  const client = yield* DevToolsClient
  const currentTracer = yield* Effect.tracer

  return Tracer.make({
    span(options) {
      const span = currentTracer.span(options)
      client.sendUnsafe(span)
      const oldEvent = span.event
      span.event = function(this: Tracer.Span, name, startTime, attributes) {
        client.sendUnsafe({
          _tag: "SpanEvent",
          traceId: span.traceId,
          spanId: span.spanId,
          name,
          startTime,
          attributes
        })
        return oldEvent.call(this, name, startTime, attributes)
      }

      const oldEnd = span.end
      span.end = function(this: Tracer.Span, endTime, exit) {
        oldEnd.call(this, endTime, exit)
        client.sendUnsafe(span)
      }

      return span
    },
    context: currentTracer.context
  })
})

/**
 * @since 4.0.0
 * @category constructors
 */
export const makeTracer: Effect.Effect<Tracer.Tracer, never, DevToolsClient> = makeTracerEffect.pipe(
  Effect.annotateLogs({
    module: "DevTools",
    service: "Tracer"
  })
)

/**
 * @since 4.0.0
 * @category layers
 */
export const layerTracer: Layer.Layer<never, never, Socket.Socket> = Layer.effect(Tracer.Tracer, makeTracer).pipe(
  Layer.provide(layer)
)
