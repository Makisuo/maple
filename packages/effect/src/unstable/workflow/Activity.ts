/**
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import { dual } from "../../Function.ts"
import { PipeInspectableProto, YieldableProto } from "../../internal/core.ts"
import * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import type { Scope } from "../../Scope.ts"
import * as ServiceMap from "../../ServiceMap.ts"
import type * as Types from "../../Types.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { makeHashDigest } from "./internal/crypto.ts"
import * as Workflow from "./Workflow.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/Activity"

/**
 * @since 4.0.0
 * @category Models
 */
export interface Activity<
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never,
  R = never
> extends
  Effect.Yieldable<
    Activity<Success, Error, R>,
    Success["Type"],
    Error["Type"],
    Success["DecodingServices"] | Error["DecodingServices"] | R | WorkflowEngine | WorkflowInstance
  >
{
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly exitSchema: Schema.Exit<Success, Error, Schema.Defect>
  readonly execute: Effect.Effect<
    Success["Type"],
    Error["Type"],
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
    | R
    | Scope
    | WorkflowEngine
    | WorkflowInstance
  >
  readonly executeEncoded: Effect.Effect<
    unknown,
    unknown,
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
    | R
    | Scope
    | WorkflowEngine
    | WorkflowInstance
  >
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly executeEncoded: Effect.Effect<any, any, any>
}

/**
 * @since 4.0.0
 * @category Models
 */
export interface AnyWithProps {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly executeEncoded: Effect.Effect<any, any, any>
}

/**
 * @since 4.0.0
 * @category Constructors
 */
export const make = <
  R,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(options: {
  readonly name: string
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  readonly execute: Effect.Effect<Success["Type"], Error["Type"], R>
  readonly interruptRetryPolicy?: Schedule.Schedule<any, Cause.Cause<unknown>> | undefined
}): Activity<Success, Error, Exclude<R, WorkflowInstance | WorkflowEngine | Scope>> => {
  const successSchema = options.success ?? (Schema.Void as any as Success)
  const errorSchema = options.error ?? (Schema.Never as any as Error)
  const successSchemaJson = Schema.toCodecJson(successSchema)
  const errorSchemaJson = Schema.toCodecJson(errorSchema)
  // oxlint-disable-next-line prefer-const
  let execute!: Effect.Effect<Success["Type"], Error["Type"], any>
  const executeWithoutInterrupt = retryOnInterrupt(
    options.name,
    options.interruptRetryPolicy
  )(options.execute)
  const self: Activity<Success, Error, Exclude<R, WorkflowInstance | WorkflowEngine>> = {
    ...PipeInspectableProto,
    ...YieldableProto,
    [TypeId]: TypeId,
    name: options.name,
    successSchema,
    errorSchema,
    exitSchema: Schema.Exit(successSchemaJson, errorSchemaJson, Schema.Defect),
    execute: executeWithoutInterrupt,
    executeEncoded: Effect.matchEffect(executeWithoutInterrupt, {
      onFailure: (error) => Effect.flatMap(Effect.orDie(Schema.encodeEffect(errorSchemaJson)(error)), Effect.fail),
      onSuccess: (value) => Effect.orDie(Schema.encodeEffect(successSchemaJson)(value))
    }),
    asEffect() {
      return execute
    }
  } as any
  execute = makeExecute(self)
  return self
}

const interruptRetryPolicy = Schedule.exponential(4.0, 1.5).pipe(
  Schedule.either(Schedule.spaced("10 seconds")),
  Schedule.either(Schedule.recurs(10)),
  Schedule.satisfiesInputType<Cause.Cause<unknown>>(),
  Schedule.while((meta) => Effect.succeed(Cause.hasInterrupts(meta.input)))
)

const retryOnInterrupt = (
  name: string,
  policy: Schedule.Schedule<any, Cause.Cause<unknown>> = interruptRetryPolicy
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.sandbox,
    Effect.retry(policy),
    Effect.catch((cause) => {
      if (!Cause.hasInterrupts(cause)) return Effect.failCause(cause)
      return Effect.die(`Activity "${name}" interrupted and retry attempts exhausted`)
    })
  )

/**
 * @since 4.0.0
 * @category Error handling
 */
export const retry: {
  <E, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(
    options: O
  ): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Retry.Return<R, E, A, O>
  <A, E, R, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(
    self: Effect.Effect<A, E, R>,
    options: O
  ): Effect.Retry.Return<R, E, A, O>
} = dual(
  2,
  (effect: Effect.Effect<any, any, any>, options: {}) =>
    Effect.suspend(() => {
      let attempt = 1
      return Effect.suspend(() => Effect.provideService(effect, CurrentAttempt, attempt++)).pipe(Effect.retry(options))
    })
)

/**
 * @since 4.0.0
 * @category Attempts
 */
export const CurrentAttempt = ServiceMap.Reference<number>(
  "effect/workflow/Activity/CurrentAttempt",
  { defaultValue: () => 1 }
)

/**
 * @since 4.0.0
 * @category Idempotency
 */
export const idempotencyKey: (
  name: string,
  options?: {
    readonly includeAttempt?: boolean | undefined
  } | undefined
) => Effect.Effect<string, never, WorkflowInstance> = Effect.fnUntraced(function*(name: string, options?: {
  readonly includeAttempt?: boolean | undefined
}) {
  const instance = yield* InstanceTag
  let key = `${instance.executionId}`
  if (options?.includeAttempt) {
    const attempt = yield* CurrentAttempt
    key += `-${attempt}`
  }
  key += `-${name}`
  return yield* makeHashDigest(key)
})

/**
 * @since 4.0.0
 * @category Racing
 */
export const raceAll = <const Activities extends NonEmptyReadonlyArray<Any>>(
  name: string,
  activities: Activities
): Effect.Effect<
  Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _A["Type"] : never,
  Activities[number] extends Activity<infer _A, infer _E, infer _R> ? _E["Type"] : never,
  | (Activities[number] extends Activity<infer Success, infer Error, infer R>
    ? Success["DecodingServices"] | Error["DecodingServices"] | R
    : never)
  | WorkflowEngine
  | WorkflowInstance
> =>
  DurableDeferred.raceAll({
    name: `Activity/${name}`,
    success: Schema.Union(
      activities.map((activity) => (activity as any).successSchema)
    ),
    error: Schema.Union(
      activities.map((activity) => (activity as any).errorSchema)
    ),
    effects: activities.map((activity) => (activity as any).asEffect()) as any
  }) as any

// -----------------------------------------------------------------------------
// internal
// -----------------------------------------------------------------------------

const EngineTag = ServiceMap.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)
const InstanceTag = ServiceMap.Service<WorkflowInstance, WorkflowInstance["Service"]>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

const makeExecute = Effect.fnUntraced(function*<
  R,
  Success extends Schema.Top = typeof Schema.Void,
  Error extends Schema.Top = typeof Schema.Never
>(activity: Activity<Success, Error, R>) {
  const engine = yield* EngineTag
  const instance = yield* InstanceTag
  const attempt = yield* CurrentAttempt
  yield* Effect.annotateCurrentSpan({ executionId: instance.executionId })
  const result = yield* Workflow.wrapActivityResult(
    engine.activityExecute(activity, attempt),
    (_) => _._tag === "Suspended"
  )
  if (result._tag === "Suspended") {
    return yield* Workflow.suspend(instance)
  }
  return yield* result.exit
}, (effect, activity) =>
  Effect.withSpan(effect, activity.name, {
    captureStackTrace: false
  }))
