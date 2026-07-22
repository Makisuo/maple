// Local bindings for the shared @maple/ui toolbar family: the refresh button
// invalidates the `["local", …]` React Query prefix, and the time-range select
// is bound to local mode's presets.

import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
	RefreshButton as SharedRefreshButton,
	TimeRangeSelect as SharedTimeRangeSelect,
} from "@maple/ui/components/toolbar"
import { TIME_RANGES } from "../lib/time"

export { Toolbar, ToolbarSearch, ToolbarStat } from "@maple/ui/components/toolbar"

/**
 * Manual reload for the active view. Every local hook keys off `["local", …]`,
 * so invalidating that prefix refetches exactly the mounted view's queries
 * (list + facets) — React Query only refetches active observers.
 */
export function RefreshButton({ className }: { className?: string }) {
	const queryClient = useQueryClient()
	const onRefresh = useCallback(
		() => queryClient.invalidateQueries({ queryKey: ["local"] }),
		[queryClient],
	)
	return <SharedRefreshButton onRefresh={onRefresh} className={className} />
}

const RANGE_LABELS: Record<string, string> = {
	"1h": "Last 1 hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
}

const RANGE_OPTIONS = TIME_RANGES.map((range) => ({
	key: range.key,
	label: RANGE_LABELS[range.key] ?? range.label,
}))

export function TimeRangeSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
	return <SharedTimeRangeSelect ranges={RANGE_OPTIONS} value={value} onChange={onChange} />
}
