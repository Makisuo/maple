import type { ManagedRuntime } from "effect"
import { Effect, Fiber } from "effect"
import { type EffectRouterContext, getCurrentNavigationSpan } from "./router.ts"

// ---------------------------------------------------------------------------
// Structural types for TanStack Router contexts
// ---------------------------------------------------------------------------

/**
 * Structural type matching TanStack Router's loader context.
 * Used instead of `LoaderFnContext<any, ...>` to avoid erasing type info
 * with 10 `any` generic params while remaining assignable to any concrete
 * LoaderFnContext via function parameter contravariance.
 */
interface RouterLoaderContext {
  readonly params: Record<string, string>
  readonly search?: Record<string, unknown>
  readonly abortController: AbortController
  readonly preload: boolean
  readonly cause: "preload" | "enter" | "stay"
  readonly location: { readonly pathname: string; readonly search: Record<string, unknown>; readonly hash: string }
  readonly context: Record<string, unknown>
  readonly route: { readonly fullPath: string; readonly id: string }
}

/**
 * Structural type matching TanStack Router's beforeLoad context.
 */
interface RouterBeforeLoadContext {
  readonly params: Record<string, string>
  readonly search?: Record<string, unknown>
  readonly abortController: AbortController
  readonly cause: "preload" | "enter" | "stay"
  readonly location: { readonly pathname: string; readonly search: Record<string, unknown>; readonly hash: string }
  readonly context: Record<string, unknown>
  readonly route?: { readonly fullPath: string; readonly id: string }
}

// ---------------------------------------------------------------------------
// Public context types
// ---------------------------------------------------------------------------

interface EffectRouteContextBase {
  readonly params: Record<string, string>
  readonly search: Record<string, unknown>
  readonly abortController: AbortController
  readonly cause: "preload" | "enter" | "stay"
  readonly location: { readonly pathname: string; readonly search: Record<string, unknown>; readonly hash: string }
  readonly context: Record<string, unknown>
}

/**
 * The context passed to an effect loader function.
 */
export interface EffectLoaderContext extends EffectRouteContextBase {
  readonly preload: boolean
}

/**
 * The context passed to an effect beforeLoad function.
 */
export type EffectBeforeLoadContext = EffectRouteContextBase

/**
 * A function that receives route loader context and returns an Effect.
 */
export type EffectLoaderFn<A, E = never> = (ctx: EffectLoaderContext) => Effect.Effect<A, E>

/**
 * A function that receives route beforeLoad context and returns an Effect
 * that produces additional context to merge.
 */
export type EffectBeforeLoadFn<A extends Record<string, unknown>, E = never> = (
  ctx: EffectBeforeLoadContext,
) => Effect.Effect<A, E>

// ---------------------------------------------------------------------------
// effectLoader
// ---------------------------------------------------------------------------

/**
 * Wraps an Effect-returning function into a TanStack Router loader.
 *
 * The Effect is executed using the shared ManagedRuntime from the router context,
 * so all services are available. Each invocation is wrapped in a tracing span.
 * If the route's AbortController signals, the Effect fiber is interrupted.
 *
 * Note: Effect failures become Promise rejections at this boundary. Use
 * `Effect.catchTag` within your loader to handle expected errors before
 * they cross the Effect→Promise boundary.
 *
 * @example
 * ```ts
 * export const Route = createFileRoute("/traces/$traceId")({
 *   loader: effectLoader(({ params }) =>
 *     Effect.gen(function* () {
 *       const traceService = yield* TraceService
 *       return yield* traceService.getTrace(params.traceId)
 *     })
 *   ),
 * })
 * ```
 */
export function effectLoader<A, E = never>(
  fn: EffectLoaderFn<A, E>,
): (ctx: RouterLoaderContext) => Promise<A> {
  return (ctx) => {
    const effectCtx = getEffectContext(ctx.context)

    const effect = fn({
      params: ctx.params,
      search: ctx.search ?? {},
      abortController: ctx.abortController,
      preload: ctx.preload,
      cause: ctx.cause,
      location: ctx.location,
      context: ctx.context,
    })

    let traced = effect.pipe(
      Effect.withSpan(`route.loader ${ctx.route.fullPath}`, {
        attributes: {
          "route.path": ctx.route.fullPath,
          "route.cause": ctx.cause,
          "route.preload": ctx.preload,
        },
      }),
    )

    const navSpan = getCurrentNavigationSpan()
    if (navSpan) {
      traced = Effect.withParentSpan(traced, navSpan)
    }

    return runWithAbort(effectCtx.effectManagedRuntime, traced, ctx.abortController.signal)
  }
}

// ---------------------------------------------------------------------------
// effectBeforeLoad
// ---------------------------------------------------------------------------

/**
 * Wraps an Effect-returning function into a TanStack Router beforeLoad hook.
 *
 * The returned context object is merged into the route context, making it
 * available to the route's loader and all child routes.
 *
 * Note: Effect failures become Promise rejections at this boundary.
 *
 * @example
 * ```ts
 * export const Route = createFileRoute("/admin")({
 *   beforeLoad: effectBeforeLoad(({ context }) =>
 *     Effect.gen(function* () {
 *       const auth = yield* AuthService
 *       const user = yield* auth.requireAdmin()
 *       return { user }
 *     })
 *   ),
 * })
 * ```
 */
export function effectBeforeLoad<A extends Record<string, unknown>, E = never>(
  fn: EffectBeforeLoadFn<A, E>,
): (ctx: RouterBeforeLoadContext) => Promise<A> {
  return (ctx) => {
    const effectCtx = getEffectContext(ctx.context)
    const routePath = ctx.route?.fullPath ?? "unknown"

    const effect = fn({
      params: ctx.params,
      search: ctx.search ?? {},
      abortController: ctx.abortController,
      location: ctx.location,
      context: ctx.context,
      cause: ctx.cause,
    })

    let traced = effect.pipe(
      Effect.withSpan(`route.beforeLoad ${routePath}`, {
        attributes: {
          "route.path": routePath,
          "route.id": ctx.route?.id ?? "unknown",
          "route.cause": ctx.cause,
        },
      }),
    )

    const navSpan = getCurrentNavigationSpan()
    if (navSpan) {
      traced = Effect.withParentSpan(traced, navSpan)
    }

    return runWithAbort(effectCtx.effectManagedRuntime, traced, ctx.abortController.signal)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the EffectRouterContext from the router context with a runtime
 * check, avoiding an unsafe `as` cast.
 */
function getEffectContext(context: Record<string, unknown>): EffectRouterContext {
  if (
    !("effectManagedRuntime" in context) ||
    !("effectAtomRuntime" in context) ||
    !("effectRegistry" in context)
  ) {
    throw new Error(
      "effect-router: effectLoader/effectBeforeLoad requires a router created with createEffectRouter()",
    )
  }
  // Safe after runtime guard validates all required keys exist
  return context as unknown as EffectRouterContext
}

/**
 * Run an Effect through a ManagedRuntime, interrupting the fiber if the
 * AbortSignal fires. Uses a single fiber fork and a single join for
 * cleanup and result retrieval.
 */
function runWithAbort<A, E>(
  managedRuntime: ManagedRuntime.ManagedRuntime<any, any>,
  effect: Effect.Effect<A, E>,
  signal: AbortSignal,
): Promise<A> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"))
  }

  const fiber = managedRuntime.runFork(effect)

  const onAbort = () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
  signal.addEventListener("abort", onAbort, { once: true })

  return Effect.runPromise(
    Fiber.join(fiber).pipe(
      Effect.onInterrupt(() =>
        Effect.logWarning("Route fiber interrupted").pipe(
          Effect.annotateLogs("signal.aborted", signal.aborted),
        ),
      ),
      Effect.ensuring(Effect.sync(() => signal.removeEventListener("abort", onAbort))),
    ),
  )
}
