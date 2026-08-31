import { describe, expect, it } from "vitest"
import {
	isNavItemActive,
	isPathActive,
	navGroups,
	paletteNavItems,
	partitionInfraSubItems,
	type NavItem,
	type NavSurface,
} from "./nav-items"
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	type OrganizationFeatureFlags,
} from "@/lib/organization-feature-flags"

function findItem(title: string, flags?: OrganizationFeatureFlags): NavItem {
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
		// rendering a gap. Runs with every flag on so the invariant also covers
		// flagged children (Agent Sessions), not just the unconditional rows.
		for (const title of ["Explore", "Infrastructure"]) {
			const item = findItem(title, ENABLED_ORGANIZATION_FEATURE_FLAGS)
			expect(item.subItems?.length).toBeGreaterThan(0)
			expect(item.subItems?.every((sub) => sub.icon)).toBe(true)
		}
	})

	it("shows Agent Sessions only behind the agentTracing flag", () => {
		// The off state is asserted with the shape production actually passes: a
		// fully-populated all-false object (what the hook returns while Clerk
		// loads and for unentitled orgs), not just an absent argument. A presence
		// check instead of `flags?.agentTracing` must fail here.
		for (const off of [undefined, DISABLED_ORGANIZATION_FEATURE_FLAGS]) {
			expect(findItem("Explore", off).subItems?.map((sub) => sub.href)).not.toContain("/agent-sessions")
			expect(paletteNavItems(off).map((entry) => entry.href)).not.toContain("/agent-sessions")
		}

		const explore = findItem("Explore", ENABLED_ORGANIZATION_FEATURE_FLAGS)
		expect(explore.subItems?.map((sub) => sub.href)).toContain("/agent-sessions")
		// The palette derives from navGroups, so the flag must gate both surfaces
		// together — findable by name exactly when the sidebar shows it.
		expect(paletteNavItems(ENABLED_ORGANIZATION_FEATURE_FLAGS).map((entry) => entry.href)).toContain(
			"/agent-sessions",
		)
	})

	it("collapses the three k8s pages to one mark, leaving five unique glyphs", () => {
		// The three k8s pages sharing one mark is deliberate — `NavRow` dedupes by
		// icon identity. Five is exactly NavRow's all-or-nothing preview cap, so a
		// sixth unique glyph here would drop the closed row's miniatures entirely
		// rather than truncate them.
		const infra = findItem("Infrastructure")
		expect(infra.subItems?.length).toBe(7)
		expect(new Set(infra.subItems?.map((sub) => sub.icon)).size).toBe(5)
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
			"Containers",
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

describe("partitionInfraSubItems", () => {
	const subItems = () => findItem("Infrastructure").subItems ?? []
	const titles = (items: ReadonlyArray<{ title: string }>) => items.map((item) => item.title)
	const present = (...surfaces: NavSurface[]) => new Set<NavSurface>(surfaces)

	it("shows every child while the org's surfaces are unknown", () => {
		const { shown, hidden } = partitionInfraSubItems(subItems(), null, "/infra")
		expect(shown).toHaveLength(7)
		expect(hidden).toEqual([])
	})

	it("shows only the surfaces the org reports", () => {
		const { shown, hidden } = partitionInfraSubItems(
			subItems(),
			present("hosts", "containers"),
			"/infra",
		)
		expect(titles(shown)).toEqual(["Hosts", "Containers"])
		expect(titles(hidden)).toEqual([
			"K8s Pods",
			"K8s Nodes",
			"K8s Workloads",
			"Cloudflare",
			"PlanetScale",
		])
	})

	it("keeps the connected integration pages", () => {
		const { shown } = partitionInfraSubItems(subItems(), present("hosts", "planetscale"), "/infra")
		expect(titles(shown)).toEqual(["Hosts", "PlanetScale"])
	})

	// Landing on a page whose row the gate would hide has to leave the section
	// pointing at where you are, not at nothing.
	it("always shows the row for the current route", () => {
		const { shown, hidden } = partitionInfraSubItems(
			subItems(),
			present("hosts"),
			"/infra/kubernetes/nodes",
		)
		expect(titles(shown)).toEqual(["Hosts", "K8s Nodes"])
		expect(titles(hidden)).not.toContain("K8s Nodes")
	})

	it("falls back to three starters when the org reports nothing", () => {
		const { shown, hidden } = partitionInfraSubItems(subItems(), present(), "/infra")
		expect(titles(shown)).toEqual(["Hosts", "Containers", "K8s Pods"])
		expect(hidden).toHaveLength(4)
	})

	// Every child stays reachable — the split shortens the default list, it does
	// not remove pages.
	it("loses nothing between the two halves", () => {
		for (const surfaces of [null, present(), present("hosts"), present("k8sPods", "cloudflare")]) {
			const { shown, hidden } = partitionInfraSubItems(subItems(), surfaces, "/infra")
			expect([...titles(shown), ...titles(hidden)].sort()).toEqual(titles(subItems()).sort())
		}
	})

	// Sections whose children carry no gate must come back untouched — the
	// function runs over all of them, not just Infrastructure.
	it("leaves ungated sections whole", () => {
		const explore = findItem("Explore").subItems ?? []
		const { shown, hidden } = partitionInfraSubItems(explore, present(), "/traces")
		expect(shown).toEqual([...explore])
		expect(hidden).toEqual([])
	})
})
