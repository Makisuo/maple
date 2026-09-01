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

	it("keeps Infrastructure at five children with five unique glyphs", () => {
		// Five is exactly NavRow's all-or-nothing preview cap, so a sixth unique
		// glyph here would drop the closed row's miniatures entirely rather than
		// truncate them. A new Kubernetes view goes in `views` (free); a new
		// child with a new glyph is not free.
		const infra = findItem("Infrastructure")
		expect(infra.subItems?.map((sub) => sub.title)).toEqual([
			"Hosts",
			"Containers",
			"Kubernetes",
			"Cloudflare",
			"PlanetScale",
		])
		expect(new Set(infra.subItems?.map((sub) => sub.icon)).size).toBe(5)
	})

	it("folds the Kubernetes views behind one row that points at the section root", () => {
		const k8s = findItem("Infrastructure").subItems?.find((sub) => sub.title === "Kubernetes")
		expect(k8s?.href).toBe("/infra/kubernetes")
		expect(k8s?.views?.map((view) => view.href)).toEqual([
			"/infra/kubernetes/pods",
			"/infra/kubernetes/workloads",
			"/infra/kubernetes/nodes",
			"/infra/kubernetes/services",
		])
		// The one row lights on every view and every detail page beneath it.
		for (const path of [
			"/infra/kubernetes",
			"/infra/kubernetes/pods",
			"/infra/kubernetes/nodes/ip-10-0-0-1",
			"/infra/kubernetes/workloads/deployment/api",
			"/infra/kubernetes/services/checkout",
		]) {
			expect(isPathActive(path, k8s?.href ?? "")).toBe(true)
		}
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
			"Kubernetes",
			"Cloudflare",
			"PlanetScale",
		]) {
			expect(titles).toContain(title)
		}
	})

	it("keeps every folded Kubernetes view typeable by name", () => {
		// The sidebar shows one Kubernetes row; the palette must not. Someone who
		// types "nodes" expects to land on the nodes list, not the section root.
		const entries = paletteNavItems()
		for (const [title, href] of [
			["Kubernetes Pods", "/infra/kubernetes/pods"],
			["Kubernetes Workloads", "/infra/kubernetes/workloads"],
			["Kubernetes Nodes", "/infra/kubernetes/nodes"],
			["Kubernetes Services", "/infra/kubernetes/services"],
		]) {
			expect(entries.find((entry) => entry.title === title)?.href).toBe(href)
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
		const { shown, suggested, hidden } = partitionInfraSubItems(subItems(), null, "/infra")
		expect(shown).toHaveLength(5)
		expect(suggested).toEqual([])
		expect(hidden).toEqual([])
	})

	it("shows the surfaces the org reports first, then pads to four", () => {
		const { shown, suggested, hidden } = partitionInfraSubItems(
			subItems(),
			present("hosts", "containers"),
			"/infra",
		)
		expect(titles(shown)).toEqual(["Hosts", "Containers"])
		expect(titles(suggested)).toEqual(["Kubernetes", "Cloudflare"])
		expect(titles(hidden)).toEqual(["PlanetScale"])
	})

	// The floor is a floor, not a cap: five reporting sources are five rows.
	it("never pads a section that already has four rows", () => {
		const { shown, suggested, hidden } = partitionInfraSubItems(
			subItems(),
			present("hosts", "containers", "k8sPods", "cloudflare"),
			"/infra",
		)
		expect(titles(shown)).toEqual(["Hosts", "Containers", "Kubernetes", "Cloudflare"])
		expect(suggested).toEqual([])
		expect(titles(hidden)).toEqual(["PlanetScale"])

		const all = partitionInfraSubItems(
			subItems(),
			present("hosts", "containers", "k8sPods", "cloudflare", "planetscale"),
			"/infra",
		)
		expect(all.shown).toHaveLength(5)
		expect(all.suggested).toEqual([])
		expect(all.hidden).toEqual([])
	})

	it("keeps the connected integration pages ahead of the suggestions", () => {
		const { shown, suggested } = partitionInfraSubItems(
			subItems(),
			present("hosts", "planetscale"),
			"/infra",
		)
		expect(titles(shown)).toEqual(["Hosts", "PlanetScale"])
		expect(titles(suggested)).toEqual(["Containers", "Kubernetes"])
	})

	// Landing on a page whose row the gate would hide has to leave the section
	// pointing at where you are, not at nothing — and as a row you have, not a
	// suggestion.
	it("always shows the row for the current route", () => {
		const { shown, suggested, hidden } = partitionInfraSubItems(
			subItems(),
			present("hosts"),
			"/infra/kubernetes/nodes",
		)
		expect(titles(shown)).toEqual(["Hosts", "Kubernetes"])
		expect(titles(suggested)).toEqual(["Containers", "Cloudflare"])
		expect(titles(hidden)).toEqual(["PlanetScale"])
	})

	// Off the section (say, on /services) nothing is the current route, so all
	// four rows are offers. On /infra the Hosts row is where you are.
	it("offers four starters when the org reports nothing", () => {
		const away = partitionInfraSubItems(subItems(), present(), "/services")
		expect(away.shown).toEqual([])
		expect(titles(away.suggested)).toEqual(["Hosts", "Containers", "Kubernetes", "Cloudflare"])
		expect(titles(away.hidden)).toEqual(["PlanetScale"])

		const home = partitionInfraSubItems(subItems(), present(), "/infra")
		expect(titles(home.shown)).toEqual(["Hosts"])
		expect(titles(home.suggested)).toEqual(["Containers", "Kubernetes", "Cloudflare"])
	})

	// A cluster that only ships node metrics is still a cluster: the row gates on
	// any of its three surfaces, not on pods specifically.
	it("shows Kubernetes when any of its surfaces reports", () => {
		for (const surface of ["k8sPods", "k8sNodes", "k8sWorkloads"] as const) {
			const { shown } = partitionInfraSubItems(subItems(), present("hosts", surface), "/infra")
			expect(titles(shown)).toEqual(["Hosts", "Kubernetes"])
		}
	})

	// Every child stays reachable — the split shortens the default list, it does
	// not remove pages.
	it("loses nothing between the three parts", () => {
		for (const surfaces of [null, present(), present("hosts"), present("k8sPods", "cloudflare")]) {
			const { shown, suggested, hidden } = partitionInfraSubItems(subItems(), surfaces, "/infra")
			expect([...titles(shown), ...titles(suggested), ...titles(hidden)].sort()).toEqual(
				titles(subItems()).sort(),
			)
			expect(shown.length + suggested.length).toBeGreaterThanOrEqual(4)
		}
	})

	// Sections whose children carry no gate must come back untouched — the
	// function runs over all of them, not just Infrastructure.
	it("leaves ungated sections whole", () => {
		const explore = findItem("Explore").subItems ?? []
		const { shown, suggested, hidden } = partitionInfraSubItems(explore, present(), "/traces")
		expect(shown).toEqual([...explore])
		expect(suggested).toEqual([])
		expect(hidden).toEqual([])
	})
})
