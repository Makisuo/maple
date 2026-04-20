/**
 * @since 2.0.0
 */
import type * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import * as Fiber from "./Fiber.ts"
import * as Layer from "./Layer.ts"
import { hasProperty } from "./Predicate.ts"
import * as Scope from "./Scope.ts"
import type { Mutable } from "./Types.ts"

const TypeId = "~effect/ManagedRuntime"

/**
 * Checks if the provided argument is a `ManagedRuntime`.
 *
 * @since 3.9.0
 * @category guards
 */
export const isManagedRuntime = (input: unknown): input is ManagedRuntime<unknown, unknown> =>
  hasProperty(input, TypeId)

/**
 * @since 3.4.0
 */
export declare namespace ManagedRuntime {
  /**
   * @category type-level
   * @since 4.0.0
   */
  export type Services<T extends ManagedRuntime<never, any>> = [T] extends [ManagedRuntime<infer R, infer _E>] ? R
    : never
  /**
   * @category type-level
   * @since 3.4.0
   */
  export type Error<T extends ManagedRuntime<never, any>> = [T] extends [ManagedRuntime<infer _R, infer E>] ? E : never
}

/**
 * @since 2.0.0
 * @category models
 */
export interface ManagedRuntime<in R, out ER> {
  readonly [TypeId]: typeof TypeId
  readonly memoMap: Layer.MemoMap
  readonly contextEffect: Effect.Effect<Context.Context<R>, ER>
  readonly context: () => Promise<Context.Context<R>>

  // internal
  readonly scope: Scope.Closeable
  // internal
  cachedContext: Context.Context<R> | undefined

  /**
   * Executes the effect using the provided Scheduler or using the global
   * Scheduler if not provided
   */
  readonly runFork: <A, E>(
    self: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions
  ) => Fiber.Fiber<A, E | ER>

  /**
   * Executes the effect synchronously returning the exit.
   *
   * This method is effectful and should only be invoked at the edges of your
   * program.
   */
  readonly runSyncExit: <A, E>(effect: Effect.Effect<A, E, R>) => Exit.Exit<A, ER | E>

  /**
   * Executes the effect synchronously throwing in case of errors or async boundaries.
   *
   * This method is effectful and should only be invoked at the edges of your
   * program.
   */
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, R>) => A

  /**
   * Executes the effect asynchronously, eventually passing the exit value to
   * the specified callback.
   *
   * This method is effectful and should only be invoked at the edges of your
   * program.
   */
  readonly runCallback: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?:
      | Effect.RunOptions & {
        readonly onExit: (exit: Exit.Exit<A, E | ER>) => void
      }
      | undefined
  ) => (interruptor?: number | undefined) => void

  /**
   * Runs the `Effect`, returning a JavaScript `Promise` that will be resolved
   * with the value of the effect once the effect has been executed, or will be
   * rejected with the first error or exception throw by the effect.
   *
   * This method is effectful and should only be used at the edges of your
   * program.
   */
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<A>

  /**
   * Runs the `Effect`, returning a JavaScript `Promise` that will be resolved
   * with the `Exit` state of the effect once the effect has been executed.
   *
   * This method is effectful and should only be used at the edges of your
   * program.
   */
  readonly runPromiseExit: <A, E>(
    effect: Effect.Effect<A, E, R>,
    options?: Effect.RunOptions
  ) => Promise<Exit.Exit<A, ER | E>>

  /**
   * Dispose of the resources associated with the runtime.
   */
  readonly dispose: () => Promise<void>

  /**
   * Dispose of the resources associated with the runtime.
   */
  readonly disposeEffect: Effect.Effect<void, never, never>
}

/**
 * Convert a Layer into an ManagedRuntime, that can be used to run Effect's using
 * your services.
 *
 * @since 2.0.0
 * @category runtime class
 * @example
 * ```ts
 * import { Console, Effect, Layer, ManagedRuntime, Context } from "effect"
 *
 * class Notifications extends Context.Service<Notifications, {
 *   readonly notify: (message: string) => Effect.Effect<void>
 * }>()("Notifications") {
 *   static readonly layer = Layer.succeed(this)({
 *     notify: Effect.fn("Notifications.notify")((message) => Console.log(message))
 *   })
 * }
 *
 * async function main() {
 *   const runtime = ManagedRuntime.make(Notifications.layer)
 *   await runtime.runPromise(Effect.flatMap(
 *     Notifications.asEffect(),
 *     (_) => _.notify("Hello, world!")
 *   ))
 *   await runtime.dispose()
 * }
 *
 * main()
 * ```
 */
export const make = <R, ER>(
  layer: Layer.Layer<R, ER, never>,
  options?: {
    readonly memoMap?: Layer.MemoMap | undefined
  } | undefined
): ManagedRuntime<R, ER> => {
  const memoMap = options?.memoMap ?? Layer.makeMemoMapUnsafe()
  const scope = Scope.makeUnsafe("parallel")
  const layerScope = Scope.forkUnsafe(scope, "sequential")
  const defaultRunOptions: Effect.RunOptions = {
    onFiberStart: Fiber.runIn(scope)
  }
  const mergeRunOptions = <O extends Effect.RunOptions>(options?: O): O =>
    options
      ? {
        ...options,
        onFiberStart: options.onFiberStart ?
          (fiber) => {
            defaultRunOptions.onFiberStart!(fiber)
            options.onFiberStart!(fiber)
          } :
          defaultRunOptions.onFiberStart
      }
      : defaultRunOptions as O
  let buildFiber: Fiber.Fiber<Context.Context<R>, ER> | undefined
  const contextEffect = Effect.withFiber<Context.Context<R>, ER>((fiber) => {
    if (!buildFiber) {
      buildFiber = Effect.runFork(
        Effect.tap(
          Layer.buildWithMemoMap(layer, memoMap, layerScope),
          (context) =>
            Effect.sync(() => {
              self.cachedContext = context
            })
        ),
        { ...defaultRunOptions, scheduler: fiber.currentScheduler }
      )
    }
    return Effect.flatten(Fiber.await(buildFiber))
  })
  const self: ManagedRuntime<R, ER> = {
    [TypeId]: TypeId,
    memoMap,
    scope,
    contextEffect: contextEffect,
    cachedContext: undefined,
    context() {
      return self.cachedContext === undefined ?
        Effect.runPromise(self.contextEffect) :
        Promise.resolve(self.cachedContext)
    },
    dispose(): Promise<void> {
      return Effect.runPromise(self.disposeEffect)
    },
    disposeEffect: Effect.suspend(() => {
      ;(self as Mutable<ManagedRuntime<R, ER>>).contextEffect = Effect.die("ManagedRuntime disposed")
      self.cachedContext = undefined
      return Scope.close(self.scope, Exit.void)
    }),
    runFork<A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions): Fiber.Fiber<A, E | ER> {
      return self.cachedContext === undefined ?
        Effect.runFork(provide(self, effect), mergeRunOptions(options)) :
        Effect.runForkWith(self.cachedContext)(effect, mergeRunOptions(options))
    },
    runCallback<A, E>(
      effect: Effect.Effect<A, E, R>,
      options?: Effect.RunOptions & {
        readonly onExit: (exit: Exit.Exit<A, E | ER>) => void
      }
    ): (interruptor?: number | undefined) => void {
      return self.cachedContext === undefined ?
        Effect.runCallback(provide(self, effect), mergeRunOptions(options)) :
        Effect.runCallbackWith(self.cachedContext)(effect, mergeRunOptions(options))
    },
    runSyncExit<A, E>(effect: Effect.Effect<A, E, R>): Exit.Exit<A, E | ER> {
      return self.cachedContext === undefined ?
        Effect.runSyncExit(provide(self, effect)) :
        Effect.runSyncExitWith(self.cachedContext)(effect)
    },
    runSync<A, E>(effect: Effect.Effect<A, E, R>): A {
      return self.cachedContext === undefined ?
        Effect.runSync(provide(self, effect)) :
        Effect.runSyncWith(self.cachedContext)(effect)
    },
    runPromiseExit<A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions): Promise<Exit.Exit<A, E | ER>> {
      return self.cachedContext === undefined ?
        Effect.runPromiseExit(provide(self, effect), mergeRunOptions(options)) :
        Effect.runPromiseExitWith(self.cachedContext)(effect, mergeRunOptions(options))
    },
    runPromise<A, E>(effect: Effect.Effect<A, E, R>, options?: {
      readonly signal?: AbortSignal | undefined
    }): Promise<A> {
      return self.cachedContext === undefined ?
        Effect.runPromise(provide(self, effect), mergeRunOptions(options)) :
        Effect.runPromiseWith(self.cachedContext)(effect, mergeRunOptions(options))
    }
  }
  return self
}

function provide<R, ER, A, E>(
  managed: ManagedRuntime<R, ER>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | ER> {
  return Effect.flatMap(
    managed.contextEffect,
    (context) => Effect.provideContext(effect, context)
  )
}
