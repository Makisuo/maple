import { RouterProvider, type AnyRouter, type RouterOptions } from "@tanstack/react-router"
import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react"
import type { AtomRegistry } from "effect/unstable/reactivity"
import type { Atom } from "effect/unstable/reactivity"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"

/**
 * Props for the EffectRouterProvider component.
 */
export interface EffectRouterProviderProps {
	/**
	 * The router created by `createEffectRouter`.
	 */
	readonly router: AnyRouter

	/**
	 * The AtomRegistry. Same one passed to `createEffectRouter`.
	 */
	readonly registry: AtomRegistry.AtomRegistry

	/**
	 * Additional router context passed to `RouterProvider`.
	 * Typically used for auth state that changes at runtime.
	 */
	readonly context?: Partial<RouterOptions<any, any, any>["context"]>
}

/**
 * Combines TanStack Router's `RouterProvider` with Effect's `RegistryContext`.
 *
 * This ensures that both the router and all Effect atoms share the same
 * registry, and that `useRouteData` and other atom hooks work correctly
 * within route components.
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <EffectRouterProvider router={router} registry={registry} />
 *   )
 * }
 * ```
 */
export function EffectRouterProvider({ router, registry, context }: EffectRouterProviderProps) {
	return (
		<RegistryContext.Provider value={registry}>
			<RouterProvider router={router} context={context} />
		</RegistryContext.Provider>
	)
}

/**
 * Hook to subscribe to a route's data atom. Returns the current
 * `AsyncResult` value, which can be `Initial`, `Success`, or `Failure`.
 *
 * This hook both mounts and subscribes to the atom, ensuring that async
 * Effects are triggered and properly cleaned up on unmount.
 *
 * @example
 * ```tsx
 * const traceDataAtom = routeAtom(atomRuntime, (params: { traceId: string }) =>
 *   Effect.gen(function* () {
 *     const traceService = yield* TraceService
 *     return yield* traceService.getTrace(params.traceId)
 *   })
 * )
 *
 * function TraceDetailPage() {
 *   const { traceId } = Route.useParams()
 *   const result = useRouteData(traceDataAtom({ traceId }))
 *   // result: AsyncResult<TraceData, TraceError>
 * }
 * ```
 */
export function useRouteData<A, E>(
	atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): AsyncResult.AsyncResult<A, E> {
	useAtomMount(atom)
	return useAtomValue(atom)
}
