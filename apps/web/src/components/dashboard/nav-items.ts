import {
	BellIcon,
	ChartBarHorizontalIcon,
	ChartLineIcon,
	CircleWarningIcon,
	CloudflareIcon,
	ComputerIcon,
	FileIcon,
	GridSquareCirclePlusIcon,
	HouseIcon,
	DockerIcon,
	KubernetesIcon,
	LayersIcon,
	MagnifierCheckIcon,
	NetworkNodesIcon,
	PlanetScaleIcon,
	PlayRotateClockwiseIcon,
	PulseIcon,
	ServerIcon,
	SquareSparkleIcon,
} from "@/components/icons"
import { KUBERNETES_ROOT, KUBERNETES_VIEWS } from "@/components/infra/kubernetes/views"
import { PLANETSCALE_COLOR } from "@/components/infra/planetscale/metrics"
import type { OrganizationFeatureFlags } from "@/lib/organization-feature-flags"

/**
 * What a nav child needs from the org before it's worth a row. The five OTel
 * surfaces come from the warehouse presence probe; Cloudflare and PlanetScale
 * are integration pages, so their gate is whether the integration is connected.
 */
export type NavSurface =
	| "hosts"
	| "containers"
	| "k8sPods"
	| "k8sNodes"
	| "k8sWorkloads"
	| "cloudflare"
	| "planetscale"

export interface NavSubItem {
	title: string
	href: string
	icon?: typeof PulseIcon
	/**
	 * CSS color for marks drawn in `currentColor`. Brand marks that hardcode
	 * their own `fill` (Kubernetes, Cloudflare) already arrive in brand color and
	 * ignore this — PlanetScale ships its mark monochrome, so it needs the tint
	 * to sit beside them rather than reading as a disabled sibling.
	 */
	iconColor?: string
	/**
	 * Gate for this row: it shows when the org reports ANY of these. A child
	 * with no `surfaces` is unconditional. See `partitionInfraSubItems` for what
	 * happens when the gate says no.
	 */
	surfaces?: ReadonlyArray<NavSurface>
	/**
	 * Pages folded behind this row. They get no sidebar row of their own — that
	 * is the point of folding — but each stays typeable in ⌘K, prefixed with the
	 * row's title so "pods" still finds Kubernetes Pods.
	 */
	views?: ReadonlyArray<{ title: string; href: string }>
}

export interface NavItem {
	title: string
	href: string
	icon: typeof PulseIcon
	/**
	 * Children revealed underneath the row while the section is active. A
	 * section counts as active when the path matches its own href *or* any
	 * child's, so a parent whose href follows its first child still lights up
	 * on the siblings.
	 */
	subItems?: NavSubItem[]
	badge?: string
	/**
	 * Where the section sends you for the children it isn't showing. Present only
	 * on sections whose hidden children are offers rather than destinations — a
	 * page you don't have yet is a setup step, and a page is where that belongs.
	 */
	discoverTo?: "/infra/discover"
}

export interface NavGroup {
	/** Stable key — labels are optional, so never key off them. */
	id: string
	/** Rendered uppercase. Omitted for the lead group so Overview reads as the root. */
	label?: string
	items: NavItem[]
}

const overviewItem: NavItem = {
	title: "Overview",
	href: "/",
	icon: HouseIcon,
}

/**
 * Every child carries an icon for the same two reasons as Explore: the closed
 * row previews what's inside it (see `NavRow`), and the expanded sub-list stops
 * being ragged — before this only Cloudflare and PlanetScale had marks, so the
 * host/k8s rows sat text-only beside two brand glyphs.
 *
 * Kubernetes is one row. It used to be four (Pods, Nodes, Workloads, Services)
 * and the section read as a Kubernetes menu with some other things in it; the
 * four are views of one section now, switched by tabs on the page, and the
 * palette keeps each one typeable through `views`. Five children means five
 * unique glyphs — exactly `NavRow`'s all-or-nothing preview cap (each glyph
 * costs the label ~14px), so a sixth would drop the miniatures entirely. The
 * preview reads this whole list, not the org's pruned one: it advertises what
 * the section covers, which is the part `partitionInfraSubItems` hides.
 */
const infrastructureItem: NavItem = {
	title: "Infrastructure",
	href: "/infra",
	icon: ComputerIcon,
	discoverTo: "/infra/discover",
	subItems: [
		{ title: "Hosts", href: "/infra", icon: ServerIcon, surfaces: ["hosts"] },
		{ title: "Containers", href: "/infra/containers", icon: DockerIcon, surfaces: ["containers"] },
		{
			title: "Kubernetes",
			href: KUBERNETES_ROOT,
			icon: KubernetesIcon,
			// Any of the three: a cluster that only ships node metrics is still a
			// cluster, and the section's tabs handle the views that are empty.
			surfaces: ["k8sPods", "k8sNodes", "k8sWorkloads"],
			views: KUBERNETES_VIEWS,
		},
		{ title: "Cloudflare", href: "/infra/cloudflare", icon: CloudflareIcon, surfaces: ["cloudflare"] },
		{
			title: "PlanetScale",
			href: "/infra/planetscale",
			icon: PlanetScaleIcon,
			iconColor: PLANETSCALE_COLOR,
			surfaces: ["planetscale"],
		},
	],
}

/**
 * Shown when the org reports none of them. Not a ranking of the section — a
 * first-run answer to "what would you plug in?", so it's the three broadest
 * collector targets rather than the two that need an OAuth handshake first.
 */
const INFRA_FALLBACK: ReadonlyArray<NavSurface> = ["hosts", "containers", "k8sPods"]

export interface InfraSubItemSplit {
	/** Rendered directly under the section. */
	readonly shown: NavSubItem[]
	/** Behind the section's reveal — reachable, just not by default. */
	readonly hidden: NavSubItem[]
}

/**
 * Splits Infrastructure's children into what an org has and what it doesn't.
 *
 * Five rows is the whole section, and almost nobody runs all five — a Docker
 * shop scrolls past Kubernetes every time. So the ones reporting telemetry (or
 * connected, for the two integration pages) render, and the rest wait behind
 * the reveal.
 *
 * Three rules keep that from ever costing someone a page:
 *
 *  - `present: null` means the probe hasn't answered or has failed. Everything
 *    shows. A nav that hides rows because a query 500'd is worse than one
 *    listing a page you don't use.
 *  - The route you're on always shows, gate or no gate. Otherwise you land on
 *    /infra/kubernetes/pods and the section has no row for where you are.
 *  - An org reporting nothing gets `INFRA_FALLBACK` rather than an empty
 *    section — "you have no infrastructure" is not a useful thing for a nav to
 *    say, and the reveal still holds the other two.
 */
export function partitionInfraSubItems(
	subItems: ReadonlyArray<NavSubItem>,
	present: ReadonlySet<NavSurface> | null,
	currentPath: string,
): InfraSubItemSplit {
	if (present === null) return { shown: [...subItems], hidden: [] }

	const reports = (sub: NavSubItem) => sub.surfaces?.some((surface) => present.has(surface)) ?? false
	const anyPresent = subItems.some(reports)
	const keep = (sub: NavSubItem): boolean => {
		if (isPathActive(currentPath, sub.href)) return true
		if (!sub.surfaces) return true
		if (anyPresent) return reports(sub)
		return sub.surfaces.some((surface) => INFRA_FALLBACK.includes(surface))
	}

	const shown: NavSubItem[] = []
	const hidden: NavSubItem[] = []
	for (const sub of subItems) (keep(sub) ? shown : hidden).push(sub)
	return { shown, hidden }
}

/**
 * Traces, Logs, Metrics and Replays are one interaction — pick a time range,
 * filter, scan a list, open one — sharing a toolbar and a filter column. They
 * read as one section with four children rather than four top-level rows, using
 * the same reveal-when-active pattern Infrastructure already uses. The parent
 * href follows its first child; the underlying routes are unchanged.
 *
 * Every child carries an icon so the closed row can preview what's inside it
 * (see `NavRow`) — a section named "Explore" says nothing about the four
 * signals it hides.
 */
const exploreItem = (flags?: OrganizationFeatureFlags): NavItem => ({
	title: "Explore",
	href: "/traces",
	icon: LayersIcon,
	subItems: [
		{ title: "Traces", href: "/traces", icon: PulseIcon },
		{ title: "Logs", href: "/logs", icon: FileIcon },
		{ title: "Metrics", href: "/metrics", icon: ChartLineIcon },
		{ title: "Replays", href: "/replays", icon: PlayRotateClockwiseIcon },
		// Behind the `agent_tracing` rollout flag. The parameter is optional on
		// purpose: a caller with no organization context yet hides the row rather
		// than flashing it (see `navGroups`).
		...(flags?.agentTracing
			? [{ title: "Agent Sessions", href: "/agent-sessions", icon: SquareSparkleIcon }]
			: []),
	],
})

/**
 * The sidebar's information architecture, and the single source the command
 * palette flattens. Anomalies is reachable at /anomalies but stays out of both
 * until the detector has been validated against production baselines.
 *
 * `flags` is *optional*, so a caller with no organization context yet hides a
 * flagged row rather than flashing it — a row that appears and then vanishes is
 * worse than one that arrives a beat late. Agent Sessions is the one row behind
 * a staged rollout right now (`agentTracing`).
 */
export function navGroups(flags?: OrganizationFeatureFlags): NavGroup[] {
	const analyzeItems: NavItem[] = [
		exploreItem(flags),
		{ title: "Web Analytics", href: "/analytics", icon: ChartBarHorizontalIcon },
		{ title: "Dashboards", href: "/dashboards", icon: GridSquareCirclePlusIcon },
	]

	return [
		{ id: "overview", items: [overviewItem] },
		{
			id: "monitor",
			label: "Monitor",
			items: [
				{ title: "Services", href: "/services", icon: ServerIcon },
				{ title: "Service Map", href: "/service-map", icon: NetworkNodesIcon },
				infrastructureItem,
			],
		},
		{
			id: "analyze",
			label: "Analyze",
			items: analyzeItems,
		},
		{
			id: "triage",
			label: "Triage",
			items: [
				{ title: "Investigations", href: "/investigations", icon: MagnifierCheckIcon },
				{ title: "Errors", href: "/errors", icon: CircleWarningIcon },
				{ title: "Alerts", href: "/alerts", icon: BellIcon },
			],
		},
	]
}

/**
 * Segment-aware prefix match. A bare `startsWith` lets /services claim
 * /service-map the moment two top-level routes share a prefix.
 */
export function isPathActive(currentPath: string, href: string): boolean {
	if (href === "/") return currentPath === "/" || currentPath === ""
	return currentPath === href || currentPath.startsWith(`${href}/`)
}

/** A section is active on its own href or on any of its children's. */
export function isNavItemActive(currentPath: string, item: NavItem): boolean {
	if (isPathActive(currentPath, item.href)) return true
	return item.subItems?.some((sub) => isPathActive(currentPath, sub.href)) ?? false
}

export interface PaletteNavEntry {
	id: string
	title: string
	href: string
	icon?: typeof PulseIcon
}

/**
 * Flattened nav for ⌘K: every section, every child, and every view a child
 * folds. Collapsing four rows into Explore must not cost a user the ability to
 * type "logs", and collapsing four Kubernetes rows into one must not cost them
 * "pods" — the entries here are what keep muscle memory working.
 */
export function paletteNavItems(flags?: OrganizationFeatureFlags): PaletteNavEntry[] {
	const entries: PaletteNavEntry[] = []
	const seen = new Set<string>()
	const push = (entry: PaletteNavEntry) => {
		const key = `${entry.title}:${entry.href}`
		if (seen.has(key)) return
		seen.add(key)
		entries.push(entry)
	}

	for (const group of navGroups(flags)) {
		for (const item of group.items) {
			push({ id: `nav:${item.title}`, title: item.title, href: item.href, icon: item.icon })
			for (const sub of item.subItems ?? []) {
				push({
					id: `nav:${item.title}:${sub.title}`,
					title: sub.title,
					href: sub.href,
					icon: sub.icon ?? item.icon,
				})
				for (const view of sub.views ?? []) {
					push({
						id: `nav:${item.title}:${sub.title}:${view.title}`,
						title: `${sub.title} ${view.title}`,
						href: view.href,
						icon: sub.icon ?? item.icon,
					})
				}
			}
		}
	}

	return entries
}
