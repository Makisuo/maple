import * as React from "react"

import { Input } from "@maple/ui/components/ui/input"
import { Button } from "@maple/ui/components/ui/button"
import { GridIcon, MenuIcon } from "@/components/icons"
import { MetricsSummaryCards, type MetricType } from "./metrics-summary-cards"
import { MetricsTable } from "./metrics-table"
import { MetricPreviewGrid } from "./metric-preview-grid"
import type { Metric } from "@/api/warehouse/metrics"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

export type MetricsBrowseView = "grid" | "table"

export interface MetricsBrowsePatch {
	q?: string
	type?: MetricType
	view?: MetricsBrowseView
}

interface MetricsBrowseProps {
	startTime?: string
	endTime?: string
	timePreset?: string
	q: string
	type: MetricType | null
	view: MetricsBrowseView
	onPatch: (patch: MetricsBrowsePatch) => void
	onOpenMetric: (metric: Metric) => void
}

export function MetricsBrowse({
	startTime,
	endTime,
	timePreset,
	q,
	type,
	view,
	onPatch,
	onOpenMetric,
}: MetricsBrowseProps) {
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		startTime,
		endTime,
		timePreset ?? "24h",
	)

	// Search input stays local while typing and commits to the URL after a
	// pause, so the atom query (and history) aren't churned per keystroke.
	const [localSearch, setLocalSearch] = React.useState(q)
	const commitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
	React.useEffect(() => {
		setLocalSearch(q)
	}, [q])
	React.useEffect(
		() => () => {
			if (commitTimer.current) clearTimeout(commitTimer.current)
		},
		[],
	)
	const handleSearchChange = (next: string) => {
		setLocalSearch(next)
		if (commitTimer.current) clearTimeout(commitTimer.current)
		commitTimer.current = setTimeout(() => onPatch({ q: next }), 300)
	}

	const deferredSearch = React.useDeferredValue(q)

	return (
		<div className="space-y-6">
			<MetricsSummaryCards
				selectedType={type}
				onSelectType={(nextType) => onPatch({ type: nextType ?? undefined })}
				startTime={effectiveStartTime}
				endTime={effectiveEndTime}
			/>

			<div className="flex flex-wrap items-center gap-4">
				<Input
					placeholder="Search metrics..."
					value={localSearch}
					onChange={(e) => handleSearchChange(e.target.value)}
					className="max-w-sm"
				/>
				{type && (
					<span className="text-sm text-muted-foreground">
						Filtered by: <span className="font-medium">{type}</span>
					</span>
				)}
				<div className="ml-auto flex items-center gap-1">
					<Button
						variant={view === "grid" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => onPatch({ view: "grid" })}
						aria-pressed={view === "grid"}
						aria-label="Grid view"
					>
						<GridIcon size={14} />
					</Button>
					<Button
						variant={view === "table" ? "secondary" : "ghost"}
						size="sm"
						onClick={() => onPatch({ view: "table" })}
						aria-pressed={view === "table"}
						aria-label="Table view"
					>
						<MenuIcon size={14} />
					</Button>
				</div>
			</div>

			{view === "grid" ? (
				<MetricPreviewGrid
					key={`${deferredSearch}|${type ?? ""}|${effectiveStartTime}|${effectiveEndTime}`}
					search={deferredSearch}
					metricType={type}
					startTime={effectiveStartTime}
					endTime={effectiveEndTime}
					onOpenMetric={onOpenMetric}
				/>
			) : (
				<div>
					<h3 className="mb-4 text-lg font-semibold">Available Metrics</h3>
					<MetricsTable
						key={`${deferredSearch}|${type ?? ""}|${effectiveStartTime}|${effectiveEndTime}`}
						search={deferredSearch}
						metricType={type}
						onOpenMetric={onOpenMetric}
						startTime={effectiveStartTime}
						endTime={effectiveEndTime}
					/>
				</div>
			)}
		</div>
	)
}
