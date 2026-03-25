/**
 * @since 3.16.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import type * as Effect from "./Effect.ts"
import { constant } from "./Function.ts"
import * as effect from "./internal/effect.ts"
import * as Layer from "./Layer.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Schedule from "./Schedule.ts"
import * as ServiceMap from "./ServiceMap.ts"

/**
 * @since 3.16.0
 * @category Type IDs
 */
export type TypeId = "~effect/ExecutionPlan"

/**
 * @since 3.16.0
 * @category Type IDs
 */
export const TypeId: TypeId = "~effect/ExecutionPlan"

/**
 * @since 3.16.0
 * @category Guards
 */
export const isExecutionPlan = (u: unknown): u is ExecutionPlan<any> => Predicate.hasProperty(u, TypeId)

/**
 * A `ExecutionPlan` can be used with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`, allowing you to provide different resources for each step of execution until the effect succeeds or the plan is exhausted.
 *
 * ```ts
 * import type { Layer } from "effect"
 * import { Effect, ExecutionPlan, Schedule } from "effect"
 * import type { LanguageModel } from "effect/unstable/ai"
 *
 * declare const layerBad: Layer.Layer<LanguageModel.LanguageModel>
 * declare const layerGood: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const ThePlan = ExecutionPlan.make(
 *   {
 *     // First try with the bad layer 2 times with a 3 second delay between attempts
 *     provide: layerBad,
 *     attempts: 2,
 *     schedule: Schedule.spaced(3000)
 *   },
 *   // Then try with the bad layer 3 times with a 1 second delay between attempts
 *   {
 *     provide: layerBad,
 *     attempts: 3,
 *     schedule: Schedule.spaced(1000)
 *   },
 *   // Finally try with the good layer.
 *   //
 *   // If `attempts` is omitted, the plan will only attempt once, unless a schedule is provided.
 *   {
 *     provide: layerGood
 *   }
 * )
 *
 * declare const effect: Effect.Effect<
 *   void,
 *   never,
 *   LanguageModel.LanguageModel
 * >
 * const withPlan: Effect.Effect<void> = Effect.withExecutionPlan(effect, ThePlan)
 * ```
 *
 * @since 3.16.0
 * @category Models
 */
export interface ExecutionPlan<
  Config extends {
    provides: any
    input: any
    error: any
    requirements: any
  }
> extends Pipeable {
  readonly [TypeId]: TypeId
  readonly steps: NonEmptyReadonlyArray<{
    readonly provide:
      | ServiceMap.ServiceMap<Config["provides"]>
      | Layer.Layer<Config["provides"], Config["error"], Config["requirements"]>
    readonly attempts?: number | undefined
    readonly while?:
      | ((input: Config["input"]) => Effect.Effect<boolean, Config["error"], Config["requirements"]>)
      | undefined
    readonly schedule?: Schedule.Schedule<any, Config["input"], Config["requirements"]> | undefined
  }>

  /**
   * Returns an equivalent `ExecutionPlan` with the requirements satisfied,
   * using the current context.
   */
  readonly withRequirements: Effect.Effect<
    ExecutionPlan<{
      provides: Config["provides"]
      input: Config["input"]
      error: Config["error"]
      requirements: never
    }>,
    never,
    Config["requirements"]
  >
}

/**
 * @since 3.16.0
 * @category Models
 */
export type ConfigBase = {
  provides: any
  input: any
  error: any
  requirements: any
}

/**
 * Create an `ExecutionPlan`, which can be used with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`, allowing you to provide different resources for each step of execution until the effect succeeds or the plan is exhausted.
 *
 * ```ts
 * import type { Layer } from "effect"
 * import { Effect, ExecutionPlan, Schedule } from "effect"
 * import type { LanguageModel } from "effect/unstable/ai"
 *
 * declare const layerBad: Layer.Layer<LanguageModel.LanguageModel>
 * declare const layerGood: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const ThePlan = ExecutionPlan.make(
 *   {
 *     // First try with the bad layer 2 times with a 3 second delay between attempts
 *     provide: layerBad,
 *     attempts: 2,
 *     schedule: Schedule.spaced(3000)
 *   },
 *   // Then try with the bad layer 3 times with a 1 second delay between attempts
 *   {
 *     provide: layerBad,
 *     attempts: 3,
 *     schedule: Schedule.spaced(1000)
 *   },
 *   // Finally try with the good layer.
 *   //
 *   // If `attempts` is omitted, the plan will only attempt once, unless a schedule is provided.
 *   {
 *     provide: layerGood
 *   }
 * )
 *
 * declare const effect: Effect.Effect<
 *   void,
 *   never,
 *   LanguageModel.LanguageModel
 * >
 * const withPlan: Effect.Effect<void> = Effect.withExecutionPlan(effect, ThePlan)
 * ```
 *
 * @since 3.16.0
 * @category Constructors
 */
export const make = <const Steps extends NonEmptyReadonlyArray<make.Step>>(
  ...steps: Steps & { [K in keyof Steps]: make.Step }
): ExecutionPlan<{
  provides: make.StepProvides<Steps>
  input: make.StepInput<Steps>
  error:
    | (Steps[number]["provide"] extends ServiceMap.ServiceMap<infer _P> | Layer.Layer<infer _P, infer E, infer _R> ? E
      : never)
    | (Steps[number]["while"] extends (input: infer _I) => Effect.Effect<infer _A, infer _E, infer _R> ? _E : never)
  requirements:
    | (Steps[number]["provide"] extends Layer.Layer<infer _A, infer _E, infer R> ? R : never)
    | (Steps[number]["while"] extends (input: infer _I) => Effect.Effect<infer _A, infer _E, infer R> ? R : never)
    | (Steps[number]["schedule"] extends Schedule.Schedule<infer _O, infer _I, infer R> ? R : never)
}> =>
  makeProto(steps.map((options, i) => {
    if (options.attempts && options.attempts < 1) {
      throw new Error(`ExecutionPlan.make: step[${i}].attempts must be greater than 0`)
    }
    return {
      schedule: options.schedule,
      attempts: options.attempts,
      while: options.while
        ? (input: any) =>
          effect.suspend(() => {
            const result = options.while!(input)
            return typeof result === "boolean" ? effect.succeed(result) : result
          })
        : undefined,
      provide: options.provide
    }
  }) as any)

/**
 * @since 3.16.0
 */
export declare namespace make {
  /**
   * @since 3.16.0
   */
  export type Step = {
    readonly provide: ServiceMap.ServiceMap<any> | ServiceMap.ServiceMap<never> | Layer.Any
    readonly attempts?: number | undefined
    readonly while?: ((input: any) => boolean | Effect.Effect<boolean, any, any>) | undefined
    readonly schedule?: Schedule.Schedule<any, any, any> | undefined
  }

  /**
   * @since 3.16.1
   */
  export type StepProvides<Steps extends ReadonlyArray<any>, Out = unknown> = Steps extends
    readonly [infer Step, ...infer Rest] ? StepProvides<
      Rest,
      & Out
      & (
        (Step extends { readonly provide: ServiceMap.ServiceMap<infer P> | Layer.Layer<infer P, infer _E, infer _R> } ?
          P
          : unknown)
      )
    > :
    Out

  /**
   * @since 3.16.1
   */
  export type PlanProvides<Plans extends ReadonlyArray<any>, Out = unknown> = Plans extends
    readonly [infer Plan, ...infer Rest] ?
    PlanProvides<Rest, Out & (Plan extends ExecutionPlan<infer T> ? T["provides"] : unknown)> :
    Out

  /**
   * @since 3.16.0
   */
  export type StepInput<Steps extends ReadonlyArray<any>, Out = unknown> = Steps extends
    readonly [infer Step, ...infer Rest] ? StepInput<
      Rest,
      & Out
      & (
        & (Step extends { readonly while: (input: infer I) => infer _ } ? I : unknown)
        & (Step extends { readonly schedule: Schedule.Schedule<infer _O, infer I, infer _R> } ? I : unknown)
      )
    > :
    Out

  /**
   * @since 3.16.0
   */
  export type PlanInput<Plans extends ReadonlyArray<any>, Out = unknown> = Plans extends
    readonly [infer Plan, ...infer Rest] ?
    PlanInput<Rest, Out & (Plan extends ExecutionPlan<infer T> ? T["input"] : unknown)> :
    Out
}

const Proto: Omit<ExecutionPlan<any>, "steps"> = {
  [TypeId]: TypeId,
  get withRequirements() {
    const self = this as any as ExecutionPlan<any>
    return effect.servicesWith((services: ServiceMap.ServiceMap<any>) =>
      effect.succeed(makeProto(self.steps.map((step) => ({
        ...step,
        provide: Layer.isLayer(step.provide)
          ? Layer.provide(step.provide, Layer.succeedServices(services))
          : step.provide
      })) as any))
    )
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeProto = <Provides, In, PlanE, PlanR>(
  steps: ExecutionPlan<{
    provides: Provides
    input: In
    error: PlanE
    requirements: PlanR
  }>["steps"]
) => {
  const self = Object.create(Proto)
  self.steps = steps
  return self
}

/**
 * @since 3.16.0
 * @category Combining
 */
export const merge = <const Plans extends NonEmptyReadonlyArray<ExecutionPlan<any>>>(
  ...plans: Plans
): ExecutionPlan<{
  provides: make.PlanProvides<Plans>
  input: make.PlanInput<Plans>
  error: Plans[number] extends ExecutionPlan<infer T> ? T["error"] : never
  requirements: Plans[number] extends ExecutionPlan<infer T> ? T["requirements"] : never
}> => makeProto(plans.flatMap((plan) => plan.steps) as any)

/**
 * @since 4.0.0
 * @category Metadata
 */
export interface Metadata {
  readonly attempt: number
  readonly stepIndex: number
}

/**
 * @since 4.0.0
 * @category Metadata
 */
export const CurrentMetadata = ServiceMap.Reference<Metadata>("effect/ExecutionPlan/CurrentMetadata", {
  defaultValue: constant({
    attempt: 0,
    stepIndex: 0
  })
})
