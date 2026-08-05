import { useNavigate } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import { BellIcon } from "@/components/icons"
import { encodeAlertChartToSearchParam } from "@/lib/alerts/widget-chart-param"
import { planetScaleAlertSuggestions } from "./planetscale-alert-suggestions"

/**
 * "Alert on this" for a PlanetScale database.
 *
 * Reuses the alert page's existing prefill mechanism verbatim — the same
 * `chart` search param the metrics explorer and dashboard widgets already use.
 * No new route, no new form, and the operator lands on the familiar rule editor
 * with the metric and grouping already chosen.
 */
export function PlanetScaleAlertMenu({
	database,
	kind,
	disabledReason,
}: {
	database: string
	/** "mysql" or "postgresql" — picks which metric name the suggestion uses. */
	kind: string
	/** Set to disable with an explanation (e.g. metrics aren't being collected). */
	disabledReason?: string
}) {
	const navigate = useNavigate()
	const suggestions = planetScaleAlertSuggestions({ database, kind })

	if (disabledReason !== undefined) {
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<Button variant="outline" size="sm" disabled>
							<BellIcon size={14} />
							Alert on this
						</Button>
					}
				/>
				<TooltipContent>{disabledReason}</TooltipContent>
			</Tooltip>
		)
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
				<BellIcon size={14} />
				Alert on this
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-72">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Create an alert rule</DropdownMenuLabel>
					{suggestions.map((suggestion) => (
						<DropdownMenuItem
							key={suggestion.id}
							onClick={() => {
								const chart = encodeAlertChartToSearchParam({
									dashboardId: "planetscale",
									widget: {
										id: crypto.randomUUID(),
										visualization: "chart",
										dataSource: {
											endpoint: "custom_query_builder_timeseries",
											params: { queries: [suggestion.draft] },
										},
										display: { title: `${suggestion.title} · ${database}` },
									},
								})
								void navigate({ to: "/alerts/create", search: chart ? { chart } : {} })
							}}
						>
							<div className="flex flex-col gap-0.5">
								<span className="text-xs font-medium">{suggestion.title}</span>
								<span className="text-[11px] text-muted-foreground">
									{suggestion.summary}
								</span>
							</div>
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
