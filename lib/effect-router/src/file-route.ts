import type { Atom } from "effect/unstable/reactivity"
import { effectLoader, effectBeforeLoad, getEffectContext } from "./route.ts"

/**
 * Context passed to a preload function.
 */
export interface PreloadContext {
	readonly params: Record<string, string>
	readonly search: Record<string, unknown>
}

/**
 * A function that returns atoms to mount before the component renders.
 * Atoms are mounted (fire-and-forget) so fetches are already in-flight
 * when the component calls `useAtomValue`.
 */
export type PreloadFn = (ctx: PreloadContext) => ReadonlyArray<Atom.Atom<any>>

/**
 * Wraps a TanStack Router file route builder with Effect support.
 *
 * - `loader` accepts Effect-returning functions (auto-wrapped with tracing + abort support)
 * - `beforeLoad` accepts Effect-returning functions
 * - `validateSearch` accepts `Schema.toStandardSchemaV1(schema)`
 *
 * Pass a `preload` function as the second argument to warm atoms during
 * route transition without blocking navigation.
 *
 * @example
 * ```ts
 * import { createFileRoute } from "@tanstack/react-router"
 * import { effectRoute } from "@effect-router/core"
 * import { Schema } from "effect"
 *
 * export const Route = effectRoute(createFileRoute("/traces/$traceId"), ({ params }) => [
 *   getSpanHierarchyResultAtom({ traceId: params.traceId }),
 *   getTraceDataResultAtom({ traceId: params.traceId }),
 * ])({
 *   validateSearch: Schema.toStandardSchemaV1(SearchSchema),
 *   component: TraceDetailPage,
 * })
 * ```
 */
export function effectRoute<T extends (...args: any[]) => any>(fileRoute: T, preload?: PreloadFn): T {
	return ((options?: any) => {
		if (!options) return (fileRoute as any)()
		return (fileRoute as any)(transformOptions(options, preload))
	}) as T
}

function transformOptions(options: Record<string, any>, preload?: PreloadFn): Record<string, any> {
	const result = { ...options }

	const userLoader = typeof options.loader === "function" ? effectLoader(options.loader) : undefined

	if (preload || userLoader) {
		result.loader = (ctx: any) => {
			if (preload) {
				const { effectRegistry } = getEffectContext(ctx.context)
				const atoms = preload({ params: ctx.params, search: ctx.search ?? {} })
				for (const atom of atoms) effectRegistry.mount(atom)
			}
			if (userLoader) return userLoader(ctx)
		}
	}

	if (typeof options.beforeLoad === "function") {
		result.beforeLoad = effectBeforeLoad(options.beforeLoad)
	}

	return result
}
