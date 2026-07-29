import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { cn } from "@maple/ui/utils"
import type { ValueUnit } from "@/components/dashboard-builder/types"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"
import { PANEL_TYPES, fromPanelType, toPanelType } from "@/lib/query-builder/panel-types"
import type { StatAggregate } from "@/lib/query-builder/widget-builder-utils"

export type LegendPosition = "bottom" | "right" | "hidden"

const UNIT_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "none", label: "None" },
	{ value: "number", label: "Number" },
	{ value: "percent", label: "Percent (0–1)" },
	{ value: "percent_100", label: "Percent (0–100)" },
	{ value: "duration", label: "Duration" },
	{ value: "bytes", label: "Bytes" },
	{ value: "requests_per_sec", label: "Requests/sec" },
	{ value: "short", label: "Short" },
]

const DURATION_SCALE_OPTIONS: Array<{ value: ValueUnit; label: string }> = [
	{ value: "duration_ns", label: "ns" },
	{ value: "duration_us", label: "us" },
	{ value: "duration_ms", label: "ms" },
	{ value: "duration_s", label: "s" },
]

function isDurationUnit(value: string): boolean {
	return value.startsWith("duration_")
}

type Threshold = { value: number; color: string }

function ThresholdsEditor({
	thresholds,
	onChange,
}: {
	thresholds: Threshold[]
	onChange: (next: Threshold[]) => void
}) {
	return (
		<div className="space-y-1.5">
			<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Thresholds</p>
			<div className="flex flex-col gap-1.5">
				{thresholds.map((threshold, index) => (
					<div key={index} className="flex items-center gap-1.5">
						<input
							type="color"
							value={threshold.color.startsWith("#") ? threshold.color : "#ef4444"}
							onChange={(event) => {
								const next = thresholds.slice()
								next[index] = { ...threshold, color: event.target.value }
								onChange(next)
							}}
							className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
							aria-label="Threshold color"
						/>
						<Input
							type="number"
							value={String(threshold.value)}
							onChange={(event) => {
								const parsed = Number(event.target.value)
								const next = thresholds.slice()
								next[index] = {
									...threshold,
									value: Number.isFinite(parsed) ? parsed : 0,
								}
								onChange(next)
							}}
							className="h-8"
						/>
						<button
							type="button"
							onClick={() => onChange(thresholds.filter((_, i) => i !== index))}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded border text-muted-foreground transition-colors hover:text-foreground"
							aria-label="Remove threshold"
						>
							×
						</button>
					</div>
				))}
				<button
					type="button"
					onClick={() => onChange([...thresholds, { value: 0, color: "#ef4444" }])}
					className="h-8 rounded-md border border-dashed text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					+ Add threshold
				</button>
			</div>
		</div>
	)
}

export function WidgetSettingsBar({ sourceMode = "builder" }: { sourceMode?: "builder" | "rawSql" }) {
	const {
		state,
		actions: { setState },
		meta: { seriesFieldOptions },
	} = useWidgetBuilder()

	const {
		visualization,
		title,
		description,
		chartId,
		stacked,
		curveType,
		comparisonMode,
		includePercentChange,
		debug,
		statAggregate,
		statValueField,
		unit,
		tableLimit,
		legendPosition,
		seriesStatsEnabled,
		heatmapColorScale,
		heatmapScaleType,
		thresholds,
		gaugeMin,
		gaugeMax,
		sparklineEnabled,
	} = state

	const onChange = (updates: Record<string, unknown>) => setState((current) => ({ ...current, ...updates }))

	// The one user-facing type axis. `visualization` + `chartId` are derived from
	// it on write, so the sections below gate on the panel type rather than on
	// `visualization` — "chart" alone can't tell a line from a bar.
	const panelType = toPanelType(visualization, chartId)

	const isChart = panelType === "line" || panelType === "bar" || panelType === "area"
	const isStat = panelType === "stat"
	const isGauge = panelType === "gauge"
	const isTable = panelType === "table"
	const isList = panelType === "list"
	const isHeatmap = panelType === "heatmap"
	const isMarkdown = panelType === "markdown"

	const showStackedToggle = panelType === "bar" || panelType === "area"
	const showCurveToggle = panelType === "line" || panelType === "area"

	const effectiveStatValueField =
		isStat &&
		seriesFieldOptions.length > 0 &&
		(!statValueField || !seriesFieldOptions.includes(statValueField))
			? seriesFieldOptions[0]
			: statValueField

	return (
		<div className="flex flex-col gap-5">
			<p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
				Panel Options
			</p>

			{/* Name */}
			<div className="space-y-1.5">
				<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Name</p>
				<Input
					value={title}
					onChange={(event) => onChange({ title: event.target.value })}
					placeholder="Untitled widget"
				/>
			</div>

			{/* Description */}
			<div className="space-y-1.5">
				<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Description</p>
				<Textarea
					value={description}
					onChange={(event) => onChange({ description: event.target.value })}
					placeholder="Add a description..."
					rows={2}
				/>
			</div>

			<div className="h-px bg-border" />

			{/* Type */}
			<div className="space-y-1.5">
				<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Type</p>
				{/* Three columns, not four: "Histogram" overflows a quarter of the
				    272px rail and collides with its neighbour. */}
				<div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/40 p-1">
					{PANEL_TYPES.map((opt) => (
						<button
							key={opt.value}
							type="button"
							onClick={() => onChange(fromPanelType(opt.value, chartId))}
							aria-pressed={panelType === opt.value}
							className={cn(
								"h-7 rounded-sm text-xs transition-colors",
								panelType === opt.value
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{opt.label}
						</button>
					))}
				</div>
			</div>

			{showStackedToggle && (
				<div className="space-y-1.5">
					<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Layout</p>
					<div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
						<button
							type="button"
							onClick={() => onChange({ stacked: false })}
							className={cn(
								"flex-1 text-xs rounded-sm transition-colors",
								!stacked
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{panelType === "bar" ? "Grouped" : "Overlapping"}
						</button>
						<button
							type="button"
							onClick={() => onChange({ stacked: true })}
							className={cn(
								"flex-1 text-xs rounded-sm transition-colors",
								stacked
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							Stacked
						</button>
					</div>
				</div>
			)}

			{showCurveToggle && (
				<div className="space-y-1.5">
					<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Curve</p>
					<div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
						<button
							type="button"
							onClick={() => onChange({ curveType: "linear" })}
							className={cn(
								"flex-1 text-xs rounded-sm transition-colors",
								curveType === "linear"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							Linear
						</button>
						<button
							type="button"
							onClick={() => onChange({ curveType: "monotone" })}
							className={cn(
								"flex-1 text-xs rounded-sm transition-colors",
								curveType === "monotone"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							Smooth
						</button>
					</div>
				</div>
			)}

			{isHeatmap && (
				<>
					<div className="h-px bg-border" />
					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">
							Color scale
						</p>
						<Select
							items={Object.fromEntries(
								(["blues", "reds", "viridis", "magma", "cividis"] as const).map((c) => [
									c,
									c[0].toUpperCase() + c.slice(1),
								]),
							)}
							value={heatmapColorScale}
							onValueChange={(value) =>
								onChange({ heatmapColorScale: value as typeof heatmapColorScale })
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(["blues", "reds", "viridis", "magma", "cividis"] as const).map((c) => (
									<SelectItem key={c} value={c}>
										{c[0].toUpperCase() + c.slice(1)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">
							Color scaling
						</p>
						<div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
							{(["linear", "log"] as const).map((mode) => (
								<button
									key={mode}
									type="button"
									onClick={() => onChange({ heatmapScaleType: mode })}
									className={cn(
										"flex-1 text-xs rounded-sm transition-colors capitalize",
										heatmapScaleType === mode
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{mode}
								</button>
							))}
						</div>
					</div>
				</>
			)}

			{(isChart || isStat || isGauge) && <div className="h-px bg-border" />}

			{/* Y-Axis Unit (for chart) / Unit (for stat & gauge) */}
			{(isChart || isStat || isGauge) && (
				<div className="space-y-1.5">
					<p className="text-[11px] uppercase tracking-wide text-muted-foreground">
						{isChart ? "Y-Axis Unit" : "Unit"}
					</p>
					<Select
						items={UNIT_OPTIONS}
						value={isDurationUnit(unit) ? "duration" : unit}
						onValueChange={(value) =>
							onChange({ unit: value === "duration" ? "duration_ms" : (value as ValueUnit) })
						}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{UNIT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{isDurationUnit(unit) && (
						<div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
							{DURATION_SCALE_OPTIONS.map((opt) => (
								<button
									key={opt.value}
									type="button"
									onClick={() => onChange({ unit: opt.value })}
									className={cn(
										"flex-1 text-xs rounded-sm transition-colors",
										unit === opt.value
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{opt.label}
								</button>
							))}
						</div>
					)}
				</div>
			)}

			{/* Legend position (chart only) */}
			{isChart && (
				<div className="space-y-1.5">
					<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Legend</p>
					<div className="flex h-9 rounded-md border bg-muted/40 p-0.5">
						{(["bottom", "right", "hidden"] as const).map((pos) => (
							<button
								key={pos}
								type="button"
								onClick={() => onChange({ legendPosition: pos })}
								className={cn(
									"flex-1 text-xs rounded-sm transition-colors capitalize",
									legendPosition === pos
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{pos === "hidden" ? "Hidden" : pos === "right" ? "Right" : "Bottom"}
							</button>
						))}
					</div>
					<div className="flex items-center gap-2 pt-0.5">
						<Checkbox
							id="qb-series-stats"
							checked={seriesStatsEnabled}
							onCheckedChange={(checked) =>
								onChange(
									// Stats live inside the legend, so enabling them with the
									// legend hidden would have no visible effect — turn the
									// legend on (bottom) in the same change.
									checked === true && legendPosition === "hidden"
										? { seriesStatsEnabled: true, legendPosition: "bottom" }
										: { seriesStatsEnabled: checked === true },
								)
							}
						/>
						<label htmlFor="qb-series-stats" className="text-xs text-muted-foreground">
							Show Min/Max/Mean/Last stats
						</label>
					</div>
				</div>
			)}

			{(isStat || isGauge) && (
				<>
					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Aggregate</p>
						<Select
							items={{
								first: "first",
								sum: "sum",
								count: "count",
								avg: "avg",
								max: "max",
								min: "min",
							}}
							value={statAggregate}
							onValueChange={(value) => onChange({ statAggregate: value as StatAggregate })}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="first">first</SelectItem>
								<SelectItem value="sum">sum</SelectItem>
								<SelectItem value="count">count</SelectItem>
								<SelectItem value="avg">avg</SelectItem>
								<SelectItem value="max">max</SelectItem>
								<SelectItem value="min">min</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">
							Value Field
						</p>
						<Select
							value={effectiveStatValueField || seriesFieldOptions[0]}
							onValueChange={(value) => onChange({ statValueField: value })}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Select series" />
							</SelectTrigger>
							<SelectContent>
								{seriesFieldOptions.map((field) => (
									<SelectItem key={field} value={field}>
										{field}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</>
			)}

			{isGauge && (
				<div className="grid grid-cols-2 gap-2">
					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Min</p>
						<Input
							type="number"
							value={gaugeMin}
							onChange={(event) => onChange({ gaugeMin: event.target.value })}
							placeholder="0"
						/>
					</div>
					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Max</p>
						<Input
							type="number"
							value={gaugeMax}
							onChange={(event) => onChange({ gaugeMax: event.target.value })}
							placeholder="100"
						/>
					</div>
				</div>
			)}

			{/*
			  * The sparkline embeds a second data source built from the query-builder
			  * state, so in Raw SQL mode it would fetch the placeholder queries rather
			  * than the user's SQL. Offer it only where it can be honest.
			  */}
			{isStat && sourceMode === "builder" && (
				<div className="flex items-center gap-2">
					<Checkbox
						id="qb-sparkline"
						checked={sparklineEnabled}
						onCheckedChange={(checked) => onChange({ sparklineEnabled: checked === true })}
					/>
					<label htmlFor="qb-sparkline" className="text-xs text-muted-foreground">
						Show sparkline
					</label>
				</div>
			)}

			{(isChart || isStat || isGauge) && (
				<ThresholdsEditor
					thresholds={thresholds}
					onChange={(next) => onChange({ thresholds: next })}
				/>
			)}

			{isTable && (
				<div className="space-y-1.5">
					<p className="text-[11px] uppercase tracking-wide text-muted-foreground">Row Limit</p>
					<Input
						value={tableLimit}
						onChange={(event) => onChange({ tableLimit: event.target.value })}
						placeholder="50"
						type="number"
						min={1}
					/>
				</div>
			)}

			{!isList && !isMarkdown && (
				<>
					<div className="h-px bg-border" />

					{/* Comparison */}
					<div className="space-y-1.5">
						<p className="text-[11px] uppercase tracking-wide text-muted-foreground">
							Comparison
						</p>
						<Select
							items={{ none: "None", previous_period: "Previous period" }}
							value={comparisonMode}
							onValueChange={(value) =>
								onChange({
									comparisonMode: value === "previous_period" ? "previous_period" : "none",
								})
							}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="none">None</SelectItem>
								<SelectItem value="previous_period">Previous period</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="h-px bg-border" />

					{/* Checkboxes */}
					<div className="flex flex-col gap-3">
						<div className="flex items-center gap-2">
							<Checkbox
								id="qb-percent-change"
								checked={includePercentChange}
								disabled={comparisonMode === "none"}
								onCheckedChange={(checked) =>
									onChange({ includePercentChange: checked === true })
								}
							/>
							<label htmlFor="qb-percent-change" className="text-xs text-muted-foreground">
								% change
							</label>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								id="qb-debug"
								checked={debug}
								onCheckedChange={(checked) => onChange({ debug: checked === true })}
							/>
							<label htmlFor="qb-debug" className="text-xs text-muted-foreground">
								Debug
							</label>
						</div>
					</div>
				</>
			)}
		</div>
	)
}
