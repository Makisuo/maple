import type { Context, Effect } from "effect"
import { ConfigProvider, Layer, ManagedRuntime } from "effect"

/**
 * Minimal shape of CF `ExecutionContext.waitUntil`. Accept any structurally
 * compatible object so callers don't need to depend on
 * `@cloudflare/workers-types` transitively.
 */
export interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void
}

/**
 * Yield one macrotask so Effect's scheduler can drain tasks queued via
 * `scheduleTask(fn, 0)`. Specifically, `HttpMiddleware.tracer` ends the HTTP
 * root Server span through this path:
 *
 *   fiber.currentDispatcher.scheduleTask(() => span.end(endTime, exit), 0)
 *
 * `scheduleTask(fn, 0)` is dispatched via `setImmediate`, which falls back to
 * `setTimeout(fn, 0)` on CF Workers — a macrotask. If we dispose the
 * per-request runtime the moment the response promise resolves, the microtask
 * firing dispose wins the race against that scheduled `span.end`, the root
 * span never lands in the OTLP buffer, and every request appears parentless
 * in Tinybird. Awaiting one `setTimeout(0)` drains the dispatcher so
 * `span.end` runs before we close the scope.
 */
const drainScheduler = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * Low-level primitive: build a fresh per-request `ManagedRuntime` from a
 * layer, return its services plus a `flush()` that drains the Effect
 * scheduler and then closes the scope. Prefer `withRequestRuntime` or
 * `runScheduledEffect` — they make the flush contract structural.
 *
 * `flush()` MUST be awaited inside `ctx.waitUntil` (or equivalent). Skipping
 * it leaks forked fibers and silently drops buffered OTLP spans/logs.
 */
export const buildRequestRuntime = <R>(
	layer: Layer.Layer<R, unknown, never>,
): {
	readonly services: Promise<Context.Context<R>>
	readonly flush: () => Promise<void>
} => {
	const runtime = ManagedRuntime.make(layer)
	const services = runtime.context().catch((err) => {
		console.error("[effect-cloudflare] runtime build failed:", err)
		throw err
	})
	const flush = async () => {
		await drainScheduler()
		try {
			await runtime.dispose()
		} catch (err) {
			console.error("[effect-cloudflare] runtime flush failed:", err)
		}
	}
	return { services, flush }
}

/**
 * Higher-order wrapper for CF Worker `fetch` handlers. Builds a fresh
 * per-request runtime from `makeLayer(env)`, injects the resolved services
 * into `handler`, and schedules `flush()` via `ctx.waitUntil` so the scope
 * is always closed after the response resolves — whether the handler
 * succeeded, threw, or returned an error response.
 *
 * Use this instead of rolling `buildRequestRuntime` + `ctx.waitUntil` by
 * hand. Forgetting the flush is the exact bug class this package exists to
 * prevent.
 */
export const withRequestRuntime = <R, Env extends Record<string, unknown>, Ctx extends ExecutionContextLike>(
	makeLayer: (env: Env) => Layer.Layer<R, unknown, never>,
	handler: (request: Request, services: Context.Context<R>, env: Env, ctx: Ctx) => Promise<Response>,
): ((request: Request, env: Env, ctx: Ctx) => Promise<Response>) => {
	return async (request, env, ctx) => {
		const { services, flush } = buildRequestRuntime(makeLayer(env))
		const resolvedServices = await services
		const response = handler(request, resolvedServices, env, ctx)
		ctx.waitUntil(
			(async () => {
				try {
					await response
				} catch {
					// Swallow handler errors — the handler's own error path is
					// responsible for surfacing them. We still need to flush so
					// the error gets traced/logged before the runtime is torn down.
				}
				await flush()
			})(),
		)
		return response
	}
}

/**
 * Run a single Effect program to completion under a fresh per-invocation
 * runtime. Intended for CF Worker `scheduled` / `queue` / workflow handlers.
 *
 * Disposes the runtime after the program settles (success or failure),
 * draining the scheduler first and registering the whole thing with
 * `ctx.waitUntil`. Rethrows so the CF runtime reports the failure.
 */
export const runScheduledEffect = <A, E, R>(
	layer: Layer.Layer<R, unknown, never>,
	program: Effect.Effect<A, E, R>,
	ctx: ExecutionContextLike,
): Promise<A> => {
	const runtime = ManagedRuntime.make(layer)
	const done = runtime.runPromise(program).finally(async () => {
		await drainScheduler()
		await runtime.dispose().catch((err) => {
			console.error("[effect-cloudflare] scheduled runtime dispose failed:", err)
		})
	})
	ctx.waitUntil(done.catch(() => undefined))
	return done
}

/**
 * Convenience: wrap `env` as an Effect `ConfigProvider` layer. Useful when
 * composing `makeTelemetryLayer` (which reads config) inside `makeLayer`.
 */
export const layerFromEnv = (env: Record<string, unknown>): Layer.Layer<never, never, never> =>
	ConfigProvider.layer(ConfigProvider.fromUnknown(env))
