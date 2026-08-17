import { createFileRoute, notFound, Outlet } from "@tanstack/react-router"

/**
 * Layout for every dev-only lab surface (see `src/lab/registry.ts`).
 *
 * The whole tree 404s in production builds: the route shells are still
 * registered (file-based routing has no per-environment tree), but nothing
 * under it is ever loaded, and the bundle-budget check forbids `src/lab/` from
 * startup regardless.
 */
export const Route = createFileRoute("/lab")({
	beforeLoad: () => {
		if (!import.meta.env.DEV) throw notFound()
	},
	component: Outlet,
})
