/**
 * @since 2.0.0
 */
import type * as Exit from "./Exit.ts"
import type { Fiber } from "./Fiber.ts"
import { constFalse, type LazyArg } from "./Function.ts"
import type * as core from "./internal/core.ts"
import type { LogLevel } from "./LogLevel.ts"
import * as Option from "./Option.ts"
import * as ServiceMap from "./ServiceMap.ts"

/**
 * @since 2.0.0
 * @category models
 */
export interface Tracer {
  span(this: Tracer, options: {
    readonly name: string
    readonly parent: Option.Option<AnySpan>
    readonly annotations: ServiceMap.ServiceMap<never>
    readonly links: Array<SpanLink>
    readonly startTime: bigint
    readonly kind: SpanKind
    readonly root: boolean
    readonly sampled: boolean
  }): Span
  readonly context?:
    | (<X>(primitive: EffectPrimitive<X>, fiber: Fiber<any, any>) => X)
    | undefined
}

const evaluate = "~effect/Effect/evaluate" satisfies core.evaluate

/**
 * @since 4.0.0
 * @category models
 */
export interface EffectPrimitive<X> {
  [evaluate](this: EffectPrimitive<X>, fiber: Fiber<any, any>): X
}

/**
 * @since 2.0.0
 * @category models
 * @example
 * ```ts
 * import type { Tracer } from "effect"
 * import { Exit } from "effect"
 *
 * // Started span status
 * const startedStatus: Tracer.SpanStatus = {
 *   _tag: "Started",
 *   startTime: BigInt(Date.now() * 1000000)
 * }
 *
 * // Ended span status
 * const endedStatus: Tracer.SpanStatus = {
 *   _tag: "Ended",
 *   startTime: BigInt(Date.now() * 1000000),
 *   endTime: BigInt(Date.now() * 1000000 + 1000000),
 *   exit: Exit.succeed("result")
 * }
 * ```
 */
export type SpanStatus = {
  _tag: "Started"
  startTime: bigint
} | {
  _tag: "Ended"
  startTime: bigint
  endTime: bigint
  exit: Exit.Exit<unknown, unknown>
}

/**
 * @since 2.0.0
 * @category models
 * @example
 * ```ts
 * import { Effect, Tracer } from "effect"
 *
 * // Function that accepts any span type
 * const logSpan = (span: Tracer.AnySpan) => {
 *   console.log(`Span ID: ${span.spanId}, Trace ID: ${span.traceId}`)
 *   return Effect.succeed(span)
 * }
 *
 * // Works with both Span and ExternalSpan
 * const externalSpan = Tracer.externalSpan({
 *   spanId: "span-123",
 *   traceId: "trace-456"
 * })
 * ```
 */
export type AnySpan = Span | ExternalSpan

/**
 * @since 2.0.0
 * @category tags
 * @example
 * ```ts
 * import { Tracer } from "effect"
 *
 * // The key used to identify parent spans in the service map
 * console.log(Tracer.ParentSpanKey) // "effect/Tracer/ParentSpan"
 * ```
 */
export const ParentSpanKey = "effect/Tracer/ParentSpan"

/**
 * @since 2.0.0
 * @category tags
 * @example
 * ```ts
 * import { Effect, Tracer } from "effect"
 *
 * // Access the parent span from the context
 * const program = Effect.gen(function*() {
 *   const parentSpan = yield* Effect.service(Tracer.ParentSpan)
 *   console.log(`Parent span: ${parentSpan.spanId}`)
 * })
 * ```
 */
export class ParentSpan extends ServiceMap.Service<ParentSpan, AnySpan>()(ParentSpanKey) {}

/**
 * @since 2.0.0
 * @category models
 * @example
 * ```ts
 * import type { Tracer } from "effect"
 * import { ServiceMap } from "effect"
 *
 * // Create an external span from another tracing system
 * const externalSpan: Tracer.ExternalSpan = {
 *   _tag: "ExternalSpan",
 *   spanId: "span-abc-123",
 *   traceId: "trace-xyz-789",
 *   sampled: true,
 *   annotations: ServiceMap.empty()
 * }
 *
 * console.log(`External span: ${externalSpan.spanId}`)
 * ```
 */
export interface ExternalSpan {
  readonly _tag: "ExternalSpan"
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean
  readonly annotations: ServiceMap.ServiceMap<never>
}

/**
 * @since 3.1.0
 * @category models
 * @example
 * ```ts
 * import type { Tracer } from "effect"
 * import { Effect } from "effect"
 *
 * // Create an effect with span options
 * const options: Tracer.SpanOptions = {
 *   attributes: { "user.id": "123", "operation": "data-processing" },
 *   kind: "internal",
 *   root: false,
 *   captureStackTrace: true
 * }
 *
 * const program = Effect.succeed("Hello World").pipe(
 *   Effect.withSpan("my-operation", options)
 * )
 * ```
 */
export interface SpanOptions extends SpanOptionsNoTrace, TraceOptions {}

/**
 * @since 3.1.0
 * @category models
 */
export interface SpanOptionsNoTrace {
  readonly attributes?: Record<string, unknown> | undefined
  readonly links?: ReadonlyArray<SpanLink> | undefined
  readonly parent?: AnySpan | undefined
  readonly root?: boolean | undefined
  readonly annotations?: ServiceMap.ServiceMap<never> | undefined
  readonly kind?: SpanKind | undefined
  readonly sampled?: boolean | undefined
  readonly level?: LogLevel | undefined
}

/**
 * @since 3.1.0
 * @category models
 */
export interface TraceOptions {
  readonly captureStackTrace?: boolean | LazyArg<string | undefined> | undefined
}

/**
 * @since 3.1.0
 * @category models
 * @example
 * ```ts
 * import type { Tracer } from "effect"
 * import { Effect } from "effect"
 *
 * // Different span kinds for different operations
 * const serverSpan = Effect.withSpan("handle-request", {
 *   kind: "server" as Tracer.SpanKind
 * })
 *
 * const clientSpan = Effect.withSpan("api-call", {
 *   kind: "client" as Tracer.SpanKind
 * })
 *
 * const internalSpan = Effect.withSpan("internal-process", {
 *   kind: "internal" as Tracer.SpanKind
 * })
 * ```
 */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer"

/**
 * @since 2.0.0
 * @category models
 * @example
 * ```ts
 * import { Effect } from "effect"
 *
 * // Working with spans using withSpan
 * const program = Effect.succeed("Hello World").pipe(
 *   Effect.withSpan("my-operation")
 * )
 *
 * // The span interface defines the properties available
 * // when working with tracing in your effects
 * ```
 */
export interface Span {
  readonly _tag: "Span"
  readonly name: string
  readonly spanId: string
  readonly traceId: string
  readonly parent: Option.Option<AnySpan>
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly status: SpanStatus
  readonly attributes: ReadonlyMap<string, unknown>
  readonly links: ReadonlyArray<SpanLink>
  readonly sampled: boolean
  readonly kind: SpanKind
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void
  attribute(key: string, value: unknown): void
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void
  addLinks(links: ReadonlyArray<SpanLink>): void
}

/**
 * @since 2.0.0
 * @category models
 * @example
 * ```ts
 * import { Effect, Tracer } from "effect"
 *
 * // Create a span link to connect spans
 * const externalSpan = Tracer.externalSpan({
 *   spanId: "external-span-123",
 *   traceId: "trace-456"
 * })
 *
 * const link: Tracer.SpanLink = {
 *   span: externalSpan,
 *   attributes: { "link.type": "follows-from", "service": "external-api" }
 * }
 *
 * const program = Effect.succeed("result").pipe(
 *   Effect.withSpan("linked-operation", { links: [link] })
 * )
 * ```
 */
export interface SpanLink {
  readonly span: AnySpan
  readonly attributes: Readonly<Record<string, unknown>>
}

/**
 * @since 2.0.0
 * @category constructors
 */
export const make = (options: Tracer): Tracer => options

/**
 * @since 2.0.0
 * @category constructors
 * @example
 * ```ts
 * import { Effect, Tracer } from "effect"
 *
 * // Create an external span from another tracing system
 * const span = Tracer.externalSpan({
 *   spanId: "span-abc-123",
 *   traceId: "trace-xyz-789",
 *   sampled: true
 * })
 *
 * // Use the external span as a parent
 * const program = Effect.succeed("Hello").pipe(
 *   Effect.withSpan("child-operation", { parent: span })
 * )
 * ```
 */
export const externalSpan = (
  options: {
    readonly spanId: string
    readonly traceId: string
    readonly sampled?: boolean | undefined
    readonly annotations?: ServiceMap.ServiceMap<never> | undefined
  }
): ExternalSpan => ({
  _tag: "ExternalSpan",
  spanId: options.spanId,
  traceId: options.traceId,
  sampled: options.sampled ?? true,
  annotations: options.annotations ?? ServiceMap.empty()
})

/**
 * @since 3.12.0
 * @category references
 * @example
 * ```ts
 * import { Effect, Tracer } from "effect"
 *
 * // Disable span propagation for a specific effect
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("This will not propagate parent span")
 * }).pipe(
 *   Effect.provideService(Tracer.DisablePropagation, true)
 * )
 * ```
 */
export const DisablePropagation = ServiceMap.Reference<boolean>(
  "effect/Tracer/DisablePropagation",
  { defaultValue: constFalse }
)

/**
 * Reference for controlling the current trace level for dynamic filtering.
 *
 * @category references
 * @since 4.0.0
 */
export const CurrentTraceLevel: ServiceMap.Reference<LogLevel> = ServiceMap.Reference<LogLevel>(
  "effect/Tracer/CurrentTraceLevel",
  { defaultValue: () => "Info" }
)

/**
 * Reference for setting the minimum trace level threshold. Spans and their
 * descendants below this level will have their sampling decision forced to
 * false, preventing them from being exported.
 *
 * @category references
 * @since 4.0.0
 */
export const MinimumTraceLevel = ServiceMap.Reference<
  LogLevel
>("effect/Tracer/MinimumTraceLevel", { defaultValue: () => "All" })

/**
 * @since 4.0.0
 * @category references
 */
export const TracerKey = "effect/Tracer"

/**
 * @since 4.0.0
 * @category references
 * @example
 * ```ts
 * import { Effect, Tracer } from "effect"
 *
 * // Access the current tracer from the context
 * const program = Effect.gen(function*() {
 *   const tracer = yield* Effect.service(Tracer.Tracer)
 *   console.log("Using current tracer")
 * })
 *
 * // Or use the built-in tracer effect
 * const tracerEffect = Effect.gen(function*() {
 *   const tracer = yield* Effect.tracer
 *   console.log("Current tracer obtained")
 * })
 * ```
 */
export const Tracer: ServiceMap.Reference<Tracer> = ServiceMap.Reference<Tracer>(TracerKey, {
  defaultValue: () =>
    make({
      span: (options) => new NativeSpan(options)
    })
})

/**
 * @since 4.0.0
 * @category native tracer
 */
export class NativeSpan implements Span {
  readonly _tag = "Span"
  readonly spanId: string
  readonly traceId: string = "native"
  readonly sampled: boolean

  readonly name: string
  readonly parent: Option.Option<AnySpan>
  readonly annotations: ServiceMap.ServiceMap<never>
  readonly links: Array<SpanLink>
  readonly startTime: bigint
  readonly kind: SpanKind

  status: SpanStatus
  attributes: Map<string, unknown>
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> = []

  constructor(options: {
    readonly name: string
    readonly parent: Option.Option<AnySpan>
    readonly annotations: ServiceMap.ServiceMap<never>
    readonly links: Array<SpanLink>
    readonly startTime: bigint
    readonly kind: SpanKind
    readonly sampled: boolean
  }) {
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.links = options.links
    this.startTime = options.startTime
    this.kind = options.kind
    this.sampled = options.sampled
    this.status = {
      _tag: "Started",
      startTime: options.startTime
    }
    this.attributes = new Map()
    this.traceId = Option.getOrUndefined(options.parent)?.traceId ?? randomHexString(32)
    this.spanId = randomHexString(16)
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      endTime,
      exit,
      startTime: this.status.startTime
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.events.push([name, startTime, attributes ?? {}])
  }

  addLinks(links: ReadonlyArray<SpanLink>): void {
    // oxlint-disable-next-line no-restricted-syntax
    this.links.push(...links)
  }
}

const randomHexString = (function() {
  const characters = "abcdef0123456789"
  const charactersLength = characters.length
  return function(length: number) {
    let result = ""
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength))
    }
    return result
  }
})()
