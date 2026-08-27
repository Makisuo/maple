import { createEffectRouter } from "@effect-router/core"

import { NotFoundError, RouteError, recordRouteErrorInfo } from "./components/route-error"
import { appRegistry, sharedAtomRuntime } from "./lib/registry"
import { runtime } from "./lib/services/common/runtime"
import { routeTree } from "./routeTree.gen"

export interface RouterAuthContext {
	isAuthenticated: boolean
	orgId: string | null | undefined
}

export const router = createEffectRouter({
	routeTree,
	managedRuntime: runtime,
	atomRuntime: sharedAtomRuntime,
	registry: appRegistry,
	scrollRestoration: true,
	// Route modules stay off the startup path, while pointer/keyboard intent
	// warms the next screen before navigation completes.
	defaultPreload: "intent",
	defaultPreloadStaleTime: 0,
	defaultErrorComponent: RouteError,
	// The boundary drops React's errorInfo before it reaches the error
	// component; this records the component stack so RouteError can report it.
	defaultOnCatch: recordRouteErrorInfo,
	defaultNotFoundComponent: NotFoundError,
	context: {
		auth: undefined!,
	},
})

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router
	}
}
