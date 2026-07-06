import {
	BellIcon,
	ChartLineIcon,
	ChatBubbleSparkleIcon,
	CircleWarningIcon,
	ComputerIcon,
	FileIcon,
	HouseIcon,
	NetworkNodesIcon,
	PlayRotateClockwiseIcon,
	PulseIcon,
	ServerIcon,
} from "@/components/icons"

export interface NavItem {
	title: string
	href: string
	icon: typeof PulseIcon
}

interface SignalsNavItem extends NavItem {
	badge?: string
	subItems?: { title: string; href: string }[]
}

export const mainNavItems: NavItem[] = [
	{
		title: "Overview",
		href: "/",
		icon: HouseIcon,
	},
	{
		title: "Chat",
		href: "/chat",
		icon: ChatBubbleSparkleIcon,
	},
]

export const topologyNavItems: NavItem[] = [
	{
		title: "Services",
		href: "/services",
		icon: ServerIcon,
	},
	{
		title: "Service Map",
		href: "/service-map",
		icon: NetworkNodesIcon,
	},
]

const signalsNavItems: SignalsNavItem[] = [
	{
		title: "Traces",
		href: "/traces",
		icon: PulseIcon,
	},
	{
		title: "Logs",
		href: "/logs",
		icon: FileIcon,
	},
	{
		title: "Metrics",
		href: "/metrics",
		icon: ChartLineIcon,
	},
	{
		title: "Replays",
		href: "/replays",
		icon: PlayRotateClockwiseIcon,
	},
	{
		title: "Infrastructure",
		href: "/infra",
		icon: ComputerIcon,
		subItems: [
			{ title: "Hosts", href: "/infra" },
			{ title: "K8s Pods", href: "/infra/kubernetes/pods" },
			{ title: "K8s Nodes", href: "/infra/kubernetes/nodes" },
			{ title: "K8s Workloads", href: "/infra/kubernetes/workloads" },
			{ title: "Cloudflare", href: "/infra/cloudflare" },
		],
	},
]

export const investigateNavItems: NavItem[] = [
	{
		title: "Errors",
		href: "/errors",
		icon: CircleWarningIcon,
	},
	// Anomalies is reachable at /anomalies but hidden from the sidebar until the
	// detector has been validated against production baselines.
	// {
	// 	title: "Anomalies",
	// 	href: "/anomalies",
	// 	icon: ChartBarTrendUpIcon,
	// },
	{
		title: "Alerts",
		href: "/alerts",
		icon: BellIcon,
	},
]

/**
 * Signals items with org feature gates applied (matches the sidebar's
 * filtering). `infra_monitoring` gates the host/k8s agent pages only —
 * Cloudflare analytics come from the integration, not the infra agent, so
 * when infra is off the Infrastructure entry collapses to just Cloudflare
 * (whose page gates itself on the integration's connection status).
 */
export function visibleSignalsNavItems(flags: { infraEnabled: boolean }) {
	if (flags.infraEnabled) return signalsNavItems
	return signalsNavItems.map((item) => {
		if (item.href !== "/infra") return item
		const subItems = item.subItems?.filter((sub) => sub.href.startsWith("/infra/cloudflare"))
		return { ...item, href: "/infra/cloudflare", subItems }
	})
}
