import { SERVICE_APP_KIND_LABELS, type ServiceAppKind } from "@maple/domain/service-app-kind"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { GlobeIcon, MobileIcon, ServerIcon } from "@/components/icons"
import { getServiceDetailOverviewResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

interface ServiceAppKindBadgeProps {
	serviceName: string
	startTime?: string
	endTime?: string
	/** Mirrors the Overview tab's bundle-atom input so this shares that fetch
	 * rather than issuing its own — same contract as
	 * `ServiceEnvironmentSwitcher`. */
	environments?: string[]
	className?: string
}

// Same token-based palette convention as `DependencyTypeBadge`: every tone maps
// onto an existing chart/severity token so the badge tracks the theme.
const tones: Record<Exclude<ServiceAppKind, "unknown">, string> = {
	browser: "bg-chart-2/10 text-chart-2",
	mobile: "bg-chart-4/10 text-chart-4",
	backend: "bg-foreground/5 text-muted-foreground",
}

function getIcon(kind: Exclude<ServiceAppKind, "unknown">) {
	switch (kind) {
		case "browser":
			return GlobeIcon
		case "mobile":
			return MobileIcon
		case "backend":
			return ServerIcon
	}
}

/**
 * What kind of app this service is, derived from its resource attributes (see
 * `classifyServiceAppKind`). It is not decoration: the same classification picks
 * the Apdex target the Overview chart is scored against, so the badge is what
 * makes that number's basis visible on the page.
 *
 * Renders nothing for `unknown` — a badge that says the product could not tell
 * is worse than no badge, and `unknown` resolves to the same default target as
 * `backend` anyway.
 */
export function ServiceAppKindBadge({
	serviceName,
	startTime,
	endTime,
	environments,
	className,
}: ServiceAppKindBadgeProps) {
	const overviewResult = useAtomValue(
		getServiceDetailOverviewResultAtom({
			data: { serviceName, startTime, endTime, environments },
		}),
	)

	const kind = Result.builder(overviewResult)
		.onSuccess((response) => response.appKind)
		.orElse((): ServiceAppKind => "unknown")

	if (kind === "unknown") return null

	const Icon = getIcon(kind)
	return (
		<Badge variant="secondary" size="sm" className={cn("uppercase", tones[kind], className)}>
			<Icon size={10} />
			{SERVICE_APP_KIND_LABELS[kind]}
		</Badge>
	)
}
