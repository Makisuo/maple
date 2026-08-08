import {
	BellIcon,
	ChartLineIcon,
	CircleWarningIcon,
	CloudflareIcon,
	ComputerIcon,
	FileIcon,
	GridSquareCirclePlusIcon,
	HouseIcon,
	KubernetesIcon,
	LayersIcon,
	MagnifierCheckIcon,
	NetworkNodesIcon,
	PlanetScaleIcon,
	PlayRotateClockwiseIcon,
	PulseIcon,
	ServerIcon,
} from "@/components/icons"
import { PLANETSCALE_COLOR } from "@/components/infra/planetscale/metrics"

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
 * four host/k8s rows sat text-only beside two brand glyphs.
 *
 * The three k8s pages deliberately share one mark: their labels already
 * separate them, and the preview dedupes by icon, so six children still fit
 * beside "Infrastructure" as four glyphs. Giving them distinct marks costs the
 * label ~14px and truncates it to "Infrastruct…".
 */
const infrastructureItem: NavItem = {
	title: "Infrastructure",
	href: "/infra",
	icon: ComputerIcon,
	subItems: [
		{ title: "Hosts", href: "/infra", icon: ServerIcon },
		{ title: "K8s Pods", href: "/infra/kubernetes/pods", icon: KubernetesIcon },
		{ title: "K8s Nodes", href: "/infra/kubernetes/nodes", icon: KubernetesIcon },
		{ title: "K8s Workloads", href: "/infra/kubernetes/workloads", icon: KubernetesIcon },
		{ title: "Cloudflare", href: "/infra/cloudflare", icon: CloudflareIcon },
		{
			title: "PlanetScale",
			href: "/infra/planetscale",
			icon: PlanetScaleIcon,
			iconColor: PLANETSCALE_COLOR,
		},
	],
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
const exploreItem: NavItem = {
	title: "Explore",
	href: "/traces",
	icon: LayersIcon,
	subItems: [
		{ title: "Traces", href: "/traces", icon: PulseIcon },
		{ title: "Logs", href: "/logs", icon: FileIcon },
		{ title: "Metrics", href: "/metrics", icon: ChartLineIcon },
		{ title: "Replays", href: "/replays", icon: PlayRotateClockwiseIcon },
	],
}

/**
 * The sidebar's information architecture, and the single source the command
 * palette flattens. Anomalies is reachable at /anomalies but stays out of both
 * until the detector has been validated against production baselines.
 */
export function navGroups(): NavGroup[] {
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
			items: [
				exploreItem,
				{ title: "Dashboards", href: "/dashboards", icon: GridSquareCirclePlusIcon },
			],
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
 * Flattened nav for ⌘K: every section *and* every child. Collapsing four rows
 * into Explore must not cost a user the ability to type "logs" — the children
 * are the entries that keep muscle memory working, and they were never in the
 * palette before this.
 */
export function paletteNavItems(): PaletteNavEntry[] {
	const entries: PaletteNavEntry[] = []
	const seen = new Set<string>()
	const push = (entry: PaletteNavEntry) => {
		const key = `${entry.title}:${entry.href}`
		if (seen.has(key)) return
		seen.add(key)
		entries.push(entry)
	}

	for (const group of navGroups()) {
		for (const item of group.items) {
			push({ id: `nav:${item.title}`, title: item.title, href: item.href, icon: item.icon })
			for (const sub of item.subItems ?? []) {
				push({
					id: `nav:${item.title}:${sub.title}`,
					title: sub.title,
					href: sub.href,
					icon: sub.icon ?? item.icon,
				})
			}
		}
	}

	return entries
}
