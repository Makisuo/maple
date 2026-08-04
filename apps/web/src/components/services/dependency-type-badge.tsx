import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import { DatabaseIcon, GlobeIcon, NetworkNodesIcon, PaperPlaneIcon, ServerIcon } from "@/components/icons"

/**
 * Visual identity for one downstream-dependency category surfaced on the
 * service-detail Dependencies tab.
 *
 *  - service   → another internal service (from `serviceDependencies`)
 *  - database  → DB target          (from `serviceDbEdges`)
 *  - http      → external HTTP host (from `serviceExternalEdges`)
 *  - messaging → message queue      (from `serviceExternalEdges`)
 *  - rpc       → RPC target         (from `serviceExternalEdges`)
 */
export type DependencyKind = "service" | "database" | "http" | "messaging" | "rpc"

interface DependencyTypeBadgeProps {
	kind: DependencyKind
	className?: string
}

const labels: Record<DependencyKind, string> = {
	service: "Service",
	database: "Database",
	http: "HTTP",
	messaging: "Queue",
	rpc: "RPC",
}

// Token-based palette so the badge tracks the user's theme. Each tone maps a
// category onto an existing chart/severity token (mirroring MetricTypeBadge) so
// no category reaches for a raw Tailwind palette color, and visual weight stays
// even across the column.
const tones: Record<DependencyKind, string> = {
	service: "bg-severity-info/10 text-severity-info",
	database: "bg-chart-3/10 text-chart-3",
	http: "bg-foreground/5 text-muted-foreground",
	messaging: "bg-chart-4/10 text-chart-4",
	rpc: "bg-chart-5/10 text-chart-5",
}

function getIcon(kind: DependencyKind) {
	switch (kind) {
		case "service":
			return ServerIcon
		case "database":
			return DatabaseIcon
		case "http":
			return GlobeIcon
		case "messaging":
			return PaperPlaneIcon
		case "rpc":
			return NetworkNodesIcon
	}
}

export function DependencyTypeBadge({ kind, className }: DependencyTypeBadgeProps) {
	const Icon = getIcon(kind)
	return (
		<Badge variant="secondary" size="sm" className={cn("uppercase", tones[kind], className)}>
			<Icon size={10} />
			{labels[kind]}
		</Badge>
	)
}
