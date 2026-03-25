/**
 * @since 4.0.0
 */
import * as Exit from "../../Exit.ts"
import { identity } from "../../Function.ts"
import type * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaTransformation from "../../SchemaTransformation.ts"

/**
 * @since 4.0.0
 * @category schemas
 */
export const SpanStatusStarted = Schema.Struct({
  _tag: Schema.tag("Started"),
  startTime: Schema.BigInt
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type SpanStatusStarted = Schema.Schema.Type<typeof SpanStatusStarted>

/**
 * @since 4.0.0
 * @category schemas
 */
export const SpanStatusEnded = Schema.Struct({
  _tag: Schema.tag("Ended"),
  startTime: Schema.BigInt,
  endTime: Schema.BigInt,
  exit: Schema.Exit(Schema.Void, Schema.DefectWithStack, Schema.DefectWithStack).pipe(
    Schema.decodeTo(
      Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Unknown),
      SchemaTransformation.transform({
        decode: identity,
        encode: Exit.asVoid
      })
    )
  )
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type SpanStatusEnded = Schema.Schema.Type<typeof SpanStatusEnded>

/**
 * @since 4.0.0
 * @category schemas
 */
export const SpanStatus = Schema.Union([SpanStatusStarted, SpanStatusEnded])

/**
 * @since 4.0.0
 * @category schemas
 */
export type SpanStatus = Schema.Schema.Type<typeof SpanStatus>

/**
 * @since 4.0.0
 * @category schemas
 */
export interface ExternalSpan {
  readonly _tag: "ExternalSpan"
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean
}

/**
 * @since 4.0.0
 * @category schemas
 */
export const ExternalSpan: Schema.Codec<ExternalSpan> = Schema.Struct({
  _tag: Schema.tag("ExternalSpan"),
  spanId: Schema.String,
  traceId: Schema.String,
  sampled: Schema.Boolean
})

/**
 * @since 4.0.0
 * @category schemas
 */
export interface Span {
  readonly _tag: "Span"
  readonly spanId: string
  readonly traceId: string
  readonly name: string
  readonly sampled: boolean
  readonly attributes: ReadonlyMap<string, unknown>
  readonly status: SpanStatus
  readonly parent: Option.Option<ParentSpan>
}

/**
 * @since 4.0.0
 * @category schemas
 */
export const Span: Schema.Codec<Span> = Schema.Struct({
  _tag: Schema.tag("Span"),
  spanId: Schema.String,
  traceId: Schema.String,
  name: Schema.String,
  sampled: Schema.Boolean,
  attributes: Schema.ReadonlyMap(Schema.String, Schema.Any),
  status: SpanStatus,
  parent: Schema.Option(Schema.suspend(() => ParentSpan))
})

/**
 * @since 4.0.0
 * @category schemas
 */
export const SpanEvent = Schema.Struct({
  _tag: Schema.tag("SpanEvent"),
  traceId: Schema.String,
  spanId: Schema.String,
  name: Schema.String,
  startTime: Schema.BigInt,
  attributes: Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Any))
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type SpanEvent = Schema.Schema.Type<typeof SpanEvent>

/**
 * @since 4.0.0
 * @category schemas
 */
export type ParentSpan = Span | ExternalSpan

/**
 * @since 4.0.0
 * @category schemas
 */
export const ParentSpan = Schema.Union([Span, ExternalSpan])

/**
 * @since 4.0.0
 * @category schemas
 */
export const Ping = Schema.Struct({
  _tag: Schema.tag("Ping")
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type Ping = Schema.Schema.Type<typeof Ping>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Pong = Schema.Struct({
  _tag: Schema.tag("Pong")
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type Pong = Schema.Schema.Type<typeof Pong>

/**
 * @since 4.0.0
 * @category schemas
 */
export const MetricsRequest = Schema.Struct({
  _tag: Schema.tag("MetricsRequest")
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type MetricsRequest = Schema.Schema.Type<typeof MetricsRequest>

/**
 * @since 4.0.0
 * @category schemas
 */
export const MetricLabel = Schema.Struct({
  key: Schema.String,
  value: Schema.String
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type MetricLabel = Schema.Schema.Type<typeof MetricLabel>

const metric = <Type extends string, State extends Schema.Top>(type: Type, state: State) =>
  Schema.Struct({
    id: Schema.String,
    type: Schema.tag(type),
    description: Schema.UndefinedOr(Schema.String),
    attributes: Schema.UndefinedOr(Schema.Record(Schema.String, Schema.String)),
    state
  })

/**
 * @since 4.0.0
 * @category schemas
 */
export const Counter = metric(
  "Counter",
  Schema.Struct({
    count: Schema.Union([Schema.Number, Schema.BigInt]),
    incremental: Schema.Boolean
  })
)

/**
 * @since 4.0.0
 * @category schemas
 */
export type Counter = Schema.Schema.Type<typeof Counter>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Frequency = metric(
  "Frequency",
  Schema.Struct({
    occurrences: Schema.ReadonlyMap(Schema.String, Schema.Number)
  })
)

/**
 * @since 4.0.0
 * @category schemas
 */
export type Frequency = Schema.Schema.Type<typeof Frequency>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Gauge = metric(
  "Gauge",
  Schema.Struct({
    value: Schema.Union([Schema.Number, Schema.BigInt])
  })
)

/**
 * @since 4.0.0
 * @category schemas
 */
export type Gauge = Schema.Schema.Type<typeof Gauge>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Histogram = metric(
  "Histogram",
  Schema.Struct({
    buckets: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
    count: Schema.Number,
    min: Schema.Number,
    max: Schema.Number,
    sum: Schema.Number
  })
)

/**
 * @since 4.0.0
 * @category schemas
 */
export type Histogram = Schema.Schema.Type<typeof Histogram>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Summary = metric(
  "Summary",
  Schema.Struct({
    quantiles: Schema.Array(Schema.Tuple([Schema.Number, Schema.UndefinedOr(Schema.Number)])),
    count: Schema.Number,
    min: Schema.Number,
    max: Schema.Number,
    sum: Schema.Number
  })
)

/**
 * @since 4.0.0
 * @category schemas
 */
export type Summary = Schema.Schema.Type<typeof Summary>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Metric = Schema.Union([Counter, Frequency, Gauge, Histogram, Summary])

/**
 * @since 4.0.0
 * @category schemas
 */
export type Metric = Schema.Schema.Type<typeof Metric>

/**
 * @since 4.0.0
 * @category schemas
 */
export const MetricsSnapshot = Schema.Struct({
  _tag: Schema.tag("MetricsSnapshot"),
  metrics: Schema.Array(Metric)
})

/**
 * @since 4.0.0
 * @category schemas
 */
export type MetricsSnapshot = Schema.Schema.Type<typeof MetricsSnapshot>

/**
 * @since 4.0.0
 * @category schemas
 */
export const Request = Schema.Union([Ping, Span, SpanEvent, MetricsSnapshot])

/**
 * @since 4.0.0
 * @category schemas
 */
export type Request = Schema.Schema.Type<typeof Request>

/**
 * @since 4.0.0
 * @category schemas
 */
export declare namespace Request {
  /**
   * @since 4.0.0
   * @category schemas
   */
  export type WithoutPing = Exclude<Request, { readonly _tag: "Ping" }>
}

/**
 * @since 4.0.0
 * @category schemas
 */
export const Response = Schema.Union([Pong, MetricsRequest])

/**
 * @since 4.0.0
 * @category schemas
 */
export type Response = Schema.Schema.Type<typeof Response>

/**
 * @since 4.0.0
 * @category schemas
 */
export declare namespace Response {
  /**
   * @since 4.0.0
   * @category schemas
   */
  export type WithoutPong = Exclude<Response, { readonly _tag: "Pong" }>
}
