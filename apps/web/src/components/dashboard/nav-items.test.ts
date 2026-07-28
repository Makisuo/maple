import { describe, expect, it } from "vitest"
import { isNavItemActive, isPathActive, navGroups, paletteNavItems, type NavItem } from "./nav-items"

const enabled = { infraEnabled: true }
const gated = { infraEnabled: false }

function findItem(flags: { infraEnabled: boolean }, title: string): NavItem {
	const item = navGroups(flags)
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
		const explore = findItem(enabled, "Explore")
		for (const path of ["/traces", "/logs", "/metrics", "/replays"]) {
			expect(isNavItemActive(path, explore)).toBe(true)
		}
		expect(isNavItemActive("/services", explore)).toBe(false)
	})

	it("keeps Explore active on a signal's detail route", () => {
		expect(isNavItemActive("/logs/abc123", findItem(enabled, "Explore"))).toBe(true)
	})

	it("keeps Infrastructure active across its children", () => {
		const infra = findItem(enabled, "Infrastructure")
		expect(isNavItemActive("/infra", infra)).toBe(true)
		expect(isNavItemActive("/infra/kubernetes/pods", infra)).toBe(true)
		expect(isNavItemActive("/infra/planetscale", infra)).toBe(true)
	})
})

describe("navGroups", () => {
	it("renders nine top-level rows at rest", () => {
		const rows = navGroups(enabled).flatMap((group) => group.items)
		expect(rows.map((item) => item.title)).toEqual([
			"Overview",
			"Services",
			"Service Map",
			"Infrastructure",
			"Explore",
			"Dashboards",
			"Investigations",
			"Errors",
			"Alerts",
		])
	})

	it("gives every Explore child an icon", () => {
		// The closed row previews its children by drawing their glyphs (see
		// `NavRow`), and draws nothing at all unless *every* child has one — so
		// dropping an icon here silently removes the preview rather than
		// rendering a gap.
		const explore = findItem(enabled, "Explore")
		expect(explore.subItems?.length).toBeGreaterThan(0)
		expect(explore.subItems?.every((sub) => sub.icon)).toBe(true)
	})

	it("keeps the Infrastructure row when the agent pages are gated off", () => {
		// The row must survive so the sidebar's shape doesn't change when the
		// Clerk flag resolves — only the children it offers do.
		const infra = findItem(gated, "Infrastructure")
		expect(infra.subItems?.map((sub) => sub.title)).toEqual(["Cloudflare", "PlanetScale"])
		expect(infra.href).toBe("/infra/cloudflare")
	})
})

describe("paletteNavItems", () => {
	it("keeps every destination the sidebar folded into a section reachable by name", () => {
		const titles = paletteNavItems(enabled).map((entry) => entry.title)
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
		const entries = paletteNavItems(enabled)
		expect(entries.find((e) => e.title === "Logs")?.href).toBe("/logs")
		expect(entries.find((e) => e.title === "Replays")?.href).toBe("/replays")
	})

	it("emits no duplicate ids", () => {
		const ids = paletteNavItems(enabled).map((entry) => entry.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("drops the gated infra children", () => {
		const titles = paletteNavItems(gated).map((entry) => entry.title)
		expect(titles).not.toContain("K8s Pods")
		expect(titles).toContain("Cloudflare")
	})
})
