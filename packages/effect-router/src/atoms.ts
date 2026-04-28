import type { Effect } from "effect"
import type { Atom } from "effect/unstable/reactivity"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

/**
 * Options for creating a route atom.
 */
export interface RouteAtomOptions {
	/**
	 * How long the atom's result should be kept alive after all subscribers
	 * unmount, in milliseconds. Prevents refetching on quick back-navigation.
	 *
	 * @default undefined (no TTL, garbage collected when unreferenced)
	 */
	readonly staleTime?: number
}

/**
 * A route atom function. Call it with params to get an atom that holds the
 * AsyncResult of the Effect execution.
 */
export type RouteAtomFn<Params, A, E> = Atom.AtomResultFn<Params, A, E>

/**
 * Creates a reactive atom powered by an Effect, designed for route-level
 * data fetching. The atom uses the shared AtomRuntime so all services
 * are available and tracing/memoization works through the same runtime.
 *
 * The returned function is parameterized - call it with route params/search
 * to get an atom instance. Atom.family semantics apply: same params = same
 * atom instance (memoized).
 *
 * @example
 * ```ts
 * const traceDataAtom = routeAtom(
 *   atomRuntime,
 *   (params: { traceId: string }) =>
 *     Effect.gen(function* () {
 *       const traceService = yield* TraceService
 *       return yield* traceService.getTrace(params.traceId)
 *     }),
 *   { staleTime: 30_000 }
 * )
 *
 * function TraceDetailPage() {
 *   const { traceId } = Route.useParams()
 *   const result = useAtomValue(traceDataAtom({ traceId }))
 *   // result: AsyncResult<TraceData, TraceError>
 * }
 * ```
 */
export function routeAtom<Params, A, E>(
	atomRuntime: Atom.AtomRuntime<any, any>,
	effectFn: (params: Params) => Effect.Effect<A, E>,
	options?: RouteAtomOptions,
): RouteAtomFn<Params, A, E> {
	// atomRuntime.fn returns AtomResultFn<Params, A, E | ER> where ER is the
	// runtime's error type. Since the runtime uses `any`, the cast narrows
	// ER back to the user's E for correct external typing.
	const atom = atomRuntime.fn<Params>()(
		(params, _get) => effectFn(params),
		options?.staleTime !== undefined ? { reactivityKeys: undefined } : undefined,
	)

	return atom as RouteAtomFn<Params, A, E>
}

/**
 * Creates a route atom that derives its params from other atoms.
 * Useful when the Effect depends on reactive state beyond just route params.
 *
 * @example
 * ```ts
 * const dashboardDataAtom = routeAtomDerived(
 *   atomRuntime,
 *   (get) => {
 *     const timeRange = get(timeRangeAtom)
 *     const environment = get(environmentAtom)
 *     return { startTime: timeRange.start, endTime: timeRange.end, environment }
 *   },
 *   (params) =>
 *     Effect.gen(function* () {
 *       const dashboard = yield* DashboardService
 *       return yield* dashboard.getData(params)
 *     }),
 * )
 * ```
 */
export function routeAtomDerived<Params, A, E>(
	atomRuntime: Atom.AtomRuntime<any, any>,
	deriveParams: (get: Atom.AtomContext) => Params,
	effectFn: (params: Params) => Effect.Effect<A, E>,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
	return atomRuntime.atom((get) => {
		const params = deriveParams(get)
		return effectFn(params)
	})
}
