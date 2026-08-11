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
/**
 * How long a preloaded atom is held mounted before it is released back to its
 * own idle TTL.
 *
 * A preload has to hold a subscription or the fetch it just started is
 * discarded before the component can read it. But holding it *forever* is the
 * trap: `mount` returns an unmount function, and dropping that pins the atom
 * for the life of the session. With preload-on-intent every hover runs the
 * loader, and keys that embed a time window roll over as the clock moves, so
 * the pinned set grows for as long as the tab is open.
 *
 * Releasing after a delay covers the hand-off both ways: if the user navigates,
 * the component has taken its own subscription long before this fires; if they
 * only hovered, the atom goes idle and expires normally.
 */
const PRELOAD_HOLD_MS = 30_000

/**
 * Start a fetch for each atom and release it once the hand-off window passes.
 */
export function warmAtoms(
	registry: { readonly mount: <A>(atom: Atom.Atom<A>) => () => void },
	atoms: ReadonlyArray<Atom.Atom<any>>,
): void {
	for (const atom of atoms) {
		const unmount = registry.mount(atom)
		setTimeout(unmount, PRELOAD_HOLD_MS)
	}
}

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
				warmAtoms(effectRegistry, preload({ params: ctx.params, search: ctx.search ?? {} }))
			}
			if (userLoader) return userLoader(ctx)
		}
	}

	if (typeof options.beforeLoad === "function") {
		result.beforeLoad = effectBeforeLoad(options.beforeLoad)
	}

	return result
}
