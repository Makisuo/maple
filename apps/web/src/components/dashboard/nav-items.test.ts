import { describe, expect, it } from "vitest"
import { isNavItemActive, isPathActive, navGroups, paletteNavItems, type NavItem } from "./nav-items"

function findItem(title: string): NavItem {
	const item = navGroups()
		.flatMap((group) => group.items)
		.find((candidate) => candidate.title === title)
	if (!item) throw new Error(`no nav item titled ${title}`)
	return item
}

describe("isPathActive", () => {
	it("matches a route and its descendants", () => {
		expect(isPathActive("/services", "/services")).toBe(true)
		expect(isPathActive("/services/checkout-svc", "/services")).toBe(true)
	})

	it("does not let a route claim a sibling that shares its prefix", () => {
		// The bug this replaces: a bare startsWith made /services light up on
		// /service-map, and would have on any future /services-foo route.
		expect(isPathActive("/service-map", "/services")).toBe(false)
		expect(isPathActive("/servicesomething", "/services")).toBe(false)
	})

	it("treats the root as exact", () => {
		expect(isPathActive("/", "/")).toBe(true)
		expect(isPathActive("/traces", "/")).toBe(false)
	})
})

describe("isNavItemActive", () => {
	it("keeps Explore active on every signal, not just its own href", () => {
		const explore = findItem("Explore")
		for (const path of ["/traces", "/logs", "/metrics", "/replays"]) {
			expect(isNavItemActive(path, explore)).toBe(true)
		}
		expect(isNavItemActive("/services", explore)).toBe(false)
	})

	it("keeps Explore active on a signal's detail route", () => {
		expect(isNavItemActive("/logs/abc123", findItem("Explore"))).toBe(true)
	})

	it("keeps Infrastructure active across its children", () => {
		const infra = findItem("Infrastructure")
		expect(isNavItemActive("/infra", infra)).toBe(true)
		expect(isNavItemActive("/infra/kubernetes/pods", infra)).toBe(true)
		expect(isNavItemActive("/infra/planetscale", infra)).toBe(true)
	})
})

describe("navGroups", () => {
	it("renders ten top-level rows", () => {
		const rows = navGroups().flatMap((group) => group.items)
		expect(rows.map((item) => item.title)).toEqual([
			"Overview",
			"Services",
			"Service Map",
			"Infrastructure",
			"Explore",
			"Web Analytics",
			"Dashboards",
			"Investigations",
			"Errors",
			"Alerts",
		])
	})

	it("reaches Web Analytics from the palette", () => {
		// The palette derives from navGroups, so the row being unconditional has to
		// mean it is typeable too — this was gated behind a rollout flag, and the
		// two surfaces went dark together.
		expect(paletteNavItems().map((entry) => entry.href)).toContain("/analytics")
	})

	it("gives every child of a previewed section an icon", () => {
		// The closed row previews its children by drawing their glyphs (see
		// `NavRow`), and draws nothing at all unless *every* child has one — so
		// dropping an icon here silently removes the preview rather than
		// rendering a gap.
		for (const title of ["Explore", "Infrastructure"]) {
			const item = findItem(title)
			expect(item.subItems?.length).toBeGreaterThan(0)
			expect(item.subItems?.every((sub) => sub.icon)).toBe(true)
		}
	})

	it("keeps Infrastructure's preview to four marks once repeats collapse", () => {
		// Six glyphs beside "Infrastructure" overflow the 16rem sidebar and
		// truncate the label to "Infrastruct…". The three k8s pages sharing one
		// mark is what buys the room back — `NavRow` dedupes by icon identity.
		const infra = findItem("Infrastructure")
		expect(new Set(infra.subItems?.map((sub) => sub.icon)).size).toBe(4)
	})
})

describe("paletteNavItems", () => {
	it("keeps every destination the sidebar folded into a section reachable by name", () => {
		const titles = paletteNavItems().map((entry) => entry.title)
		for (const title of [
			"Traces",
			"Logs",
			"Metrics",
			"Replays",
			"Hosts",
			"K8s Pods",
			"K8s Nodes",
			"K8s Workloads",
			"Cloudflare",
			"PlanetScale",
		]) {
			expect(titles).toContain(title)
		}
	})

	it("points the signal entries at their own routes", () => {
		const entries = paletteNavItems()
		expect(entries.find((e) => e.title === "Logs")?.href).toBe("/logs")
		expect(entries.find((e) => e.title === "Replays")?.href).toBe("/replays")
	})

	it("emits no duplicate ids", () => {
		const ids = paletteNavItems().map((entry) => entry.id)
		expect(new Set(ids).size).toBe(ids.length)
	})
})
