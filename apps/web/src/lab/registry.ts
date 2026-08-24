/**
 * The catalogue of dev-only lab surfaces under `/lab`.
 *
 * Two families live here: **labs** are visual galleries that render a component
 * family over fixture data (widgets, provenance nodes, trace views), **benches**
 * are the synthetic perf harnesses the Playwright gates in `perf/` drive. All of
 * them are 404 in production builds — the `/lab` layout route throws `notFound()`
 * outside `import.meta.env.DEV` — and everything under `src/lab/` is forbidden
 * from the startup bundle by `perf/check-bundle-budget.ts`.
 *
 * `registry.test.ts` asserts this list and the route tree agree, so adding a
 * file under `src/routes/lab/` without an entry here fails the test rather than
 * silently missing from the `/lab` index page.
 *
 * Deliberately dependency-free at runtime: `src/lib/public-routes.ts` imports it
 * and `main.tsx` needs that before the router exists. The route-tree import is
 * type-only so a typo in `path` is a typecheck error, not a dead link.
 */
import type { FileRoutesByTo } from "@/routeTree.gen"

export const LAB_ROOT = "/lab"

export type LabPath = Extract<keyof FileRoutesByTo, `${typeof LAB_ROOT}/${string}`>

export interface LabEntry {
	path: LabPath
	title: string
	description: string
	/** Gallery of a component family (`lab`) or a Playwright perf harness (`bench`). */
	kind: "lab" | "bench"
	/**
	 * `none`: renders from fixtures with no API and no session, so the auth gate
	 * lets it through. `required`: reads real org data and goes through sign-in.
	 */
	session: "none" | "required"
}

export const LAB_ENTRIES: ReadonlyArray<LabEntry> = [
	{
		path: "/lab/widgets",
		title: "Widgets",
		description:
			"Every dashboard widget renderer over its bundled sample data — the fastest way to eyeball a chart change without a backend.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/nodes",
		title: "Provenance nodes",
		description: "Every provenance-canvas node and edge state, in the production renderer, at 1:1.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/timeline",
		title: "Trace timeline",
		description:
			"The trace view tabs over a synthetic trace with a wide dynamic range — a 2s root down to sub-millisecond spans that only resolve at deep zoom.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/agent-session",
		title: "Agent session detail",
		description:
			"The session detail page's Overview, Trace and Flow views over a fourteen-turn fixture that ends in a context-window failure.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/flow",
		title: "Trace flow",
		description:
			"One synthetic trace exercising every Flow view card variant: server, edge, HTTP client, db, cache hit/miss, messaging, orphan.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/query-builder",
		title: "Query builder",
		description: "MVP query builder against real warehouse data for the signed-in org.",
		kind: "lab",
		session: "required",
	},
	{
		path: "/lab/bench/service-map",
		title: "Service map",
		description:
			"Synthetic topology at configurable size (?services=&edges=&rps=&seed=&groups=) with a window.__smBench FPS harness.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/service-detail",
		title: "Service detail charts",
		description:
			"The service-detail MetricsGrid with synthetic rows; ?mode=recharts|cursor picks the sync strategy.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/infra",
		title: "Infra charts",
		description: "Host and k8s detail ChartViews on one page with synthetic rows; ?mode=recharts|cursor.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/logs",
		title: "Logs table",
		description: "The real LogsTableView over 2,000 synthetic rows × 12 chips — hover and scroll perf.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/bench/overview",
		title: "Overview charts",
		description:
			"Service-detail chart bench pinned to cursor sync — the cross-browser gate's overview scenario.",
		kind: "bench",
		session: "none",
	},
	{
		path: "/lab/charts",
		title: "TanStack charts",
		description:
			"Production charts beside their TanStack counterparts over identical rows; ?renderer=tanstack-svg|tanstack-canvas.",
		kind: "lab",
		session: "none",
	},
	{
		path: "/lab/bench/tanstack",
		title: "TanStack Charts pilot",
		description:
			"The three overview charts off identical rows; ?renderer=recharts|tanstack-svg|tanstack-canvas.",
		kind: "bench",
		session: "none",
	},
]

/** Anything under the `/lab` tree, index included. */
export function isLabPath(pathname: string): boolean {
	return pathname === LAB_ROOT || pathname.startsWith(`${LAB_ROOT}/`)
}

/**
 * Lab surfaces that render without a session: the index plus every entry
 * marked `session: "none"`. Used by the auth and plan gates.
 */
export function isSessionlessLabPath(pathname: string): boolean {
	if (pathname === LAB_ROOT || pathname === `${LAB_ROOT}/`) return true
	return LAB_ENTRIES.some((entry) => entry.session === "none" && entry.path === pathname)
}
