import { createRouter as createTanStackRouter } from "@tanstack/react-router"

import { NotFoundError, RouteError } from "./components/route-error"
import { routeTree } from "./routeTree.gen"

export interface RouterAuthContext {
  isAuthenticated: boolean
  orgId: string | null | undefined
}

export const router = createTanStackRouter({
  routeTree,
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
