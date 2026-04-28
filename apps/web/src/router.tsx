import { createEffectRouter } from "@effect-router/core"

import { NotFoundError, RouteError } from "./components/route-error"
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
	defaultPreloadStaleTime: 0,
	defaultErrorComponent: RouteError,
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
