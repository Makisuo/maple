import { getRouteApi } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useLogsViewPreferences } from "@/hooks/use-logs-view-preferences"
import { getLogAttributeKeysResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { SearchableFilterSection } from "@/components/filters/filter-section"
import { LineHeightIcon, TextWrapIcon, ThumbtackIcon } from "@/components/icons"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { Badge } from "@maple/ui/components/ui/badge"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

const routeApi = getRouteApi("/logs/")

interface ColumnOption {
	name: string
	count: number
}

/**
 * View controls for the logs stream: body wrap, row density, and the
 * pin-attributes-as-columns picker. Wrap/density persist to localStorage; pinned
 * columns live in the URL (shareable) under `?columns`.
 */
export function LogsTableToolbar() {
	const navigate = routeApi.useNavigate()
	const search = routeApi.useSearch()
	const { wrap, setWrap, density, setDensity } = useLogsViewPreferences()

	const pinnedColumns = search.columns ?? []

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const keysResult = useAtomValue(getLogAttributeKeysResultAtom({ data: { startTime, endTime } }))

	const keyOptions = Result.builder(keysResult)
		.onSuccess((response): ColumnOption[] =>
			response.data.map((row) => ({ name: row.attributeKey, count: row.usageCount })),
		)
		.orElse((): ColumnOption[] => [])

	// Keep already-pinned keys selectable even if they fall outside the current
	// time range's key set (so they can be unpinned from the picker too).
	const options = [...keyOptions]
	for (const key of pinnedColumns) {
		if (!options.some((option) => option.name === key)) {
			options.push({ name: key, count: 0 })
		}
	}

	const setColumns = (next: string[]) => {
		navigate({ search: (prev) => ({ ...prev, columns: next.length > 0 ? next : undefined }) })
	}

	return (
		<TooltipProvider delay={250}>
			<div className="flex shrink-0 items-center justify-end gap-1.5 pb-1.5">
				<Tooltip>
					<Popover>
						<TooltipTrigger
							render={
								<PopoverTrigger
									className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-foreground transition-colors hover:bg-muted/64 data-[popup-open]:bg-muted/64"
									aria-label="Pin attributes as columns"
								>
									<ThumbtackIcon size={13} className="text-muted-foreground" />
									Columns
									{pinnedColumns.length > 0 && (
										<Badge variant="secondary" size="sm" className="tabular-nums">
											{pinnedColumns.length}
										</Badge>
									)}
								</PopoverTrigger>
							}
						/>
						<PopoverContent align="end" className="w-72">
							{options.length > 0 ? (
								<SearchableFilterSection
									title="Columns"
									options={options}
									selected={pinnedColumns}
									onChange={setColumns}
								/>
							) : (
								<p className="py-2 text-xs text-muted-foreground">
									No attribute keys in the selected time range.
								</p>
							)}
						</PopoverContent>
					</Popover>
					<TooltipContent>Pin attributes as columns</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger
						render={
							<Toggle
								variant="outline"
								size="sm"
								pressed={wrap}
								onPressedChange={setWrap}
								aria-label="Wrap long log lines"
							>
								<TextWrapIcon size={14} />
							</Toggle>
						}
					/>
					<TooltipContent>{wrap ? "Stop wrapping lines" : "Wrap long lines"}</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger
						render={
							<Toggle
								variant="outline"
								size="sm"
								pressed={density === "comfortable"}
								onPressedChange={(pressed) => setDensity(pressed ? "comfortable" : "compact")}
								aria-label="Toggle comfortable row density"
							>
								<LineHeightIcon size={14} />
							</Toggle>
						}
					/>
					<TooltipContent>
						{density === "comfortable" ? "Comfortable rows" : "Compact rows"}
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	)
}
