import { createContext, use, type ReactNode } from "react"

import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { cn } from "@maple/ui/lib/utils"
import { HEATMAP_COLOR_SCALES, type HeatmapColorScale } from "@maple/domain/http"
import type { ValueUnit } from "@/components/dashboard-builder/types"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { resolveTimeRange } from "@/atoms/dashboard-time-range-atoms"
import { WidgetBuilderForm } from "@/atoms/widget-query-builder-atoms"
import { useAtom } from "@/lib/effect-atom"
import { PANEL_TYPES, fromPanelType, toPanelType } from "@/lib/query-builder/panel-types"
import {
	toSeriesFieldOptions,
	type QueryBuilderWidgetState,
	type StatAggregate,
} from "@/lib/query-builder/widget-builder-shared"

// ---------------------------------------------------------------------------
// The settings rail's vocabulary.
//
// Each field reads and writes the builder state through context, so a panel
// type's settings panel is a list of the fields it offers rather than a slice of
// one form gated on `isStat && …`. The rail used to be a single 592-line
// component behind seven `isX` booleans and two `showX` booleans, where adding a
// widget type meant threading a tenth flag through every section.
// ---------------------------------------------------------------------------

export type LegendPosition = "bottom" | "right" | "hidden"

/** Raw SQL mode hides settings that are built from query-builder state. */
type SourceMode = "builder" | "rawSql"

const SourceModeContext = createContext<SourceMode>("builder")

export function SettingsSourceMode({ mode, children }: { mode: SourceMode; children: ReactNode }) {
	return <SourceModeContext value={mode}>{children}</SourceModeContext>
}

/**
 * Reads the builder form atom directly rather than going through
 * `useWidgetBuilder`. That hook depends on the widget-type registry (for
 * validation), and the registry's config panels are built from these fields — so
 * routing through it would make the module graph circular.
 */
function useSettings() {
	const [state, setState] = useAtom(WidgetBuilderForm.use())
	return {
		state,
		seriesFieldOptions: toSeriesFieldOptions(state),
		sourceMode: use(SourceModeContext),
		set: (updates: Partial<QueryBuilderWidgetState>) =>
			setState((current) => ({ ...current, ...updates })),
	}
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="space-y-1.5">
			<p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
			{children}
		</div>
	)
}

/** A recessed track of mutually exclusive options — the rail's segmented control. */
function Segments<T extends string>({
	options,
	value,
	onSelect,
	className,
}: {
	options: ReadonlyArray<{ value: T; label: string }>
	value: T
	onSelect: (next: T) => void
	className?: string
}) {
	return (
		<div className={cn("flex h-9 rounded-md border bg-muted/40 p-0.5", className)}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onSelect(option.value)}
					aria-pressed={value === option.value}
					className={cn(
						"flex-1 text-xs rounded-sm transition-colors",
						value === option.value
							? "bg-background text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}

function CheckboxRow({
	id,
	label,
	checked,
	disabled,
	onChange,
}: {
	id: string
	label: string
	checked: boolean
	disabled?: boolean
	onChange: (checked: boolean) => void
}) {
	return (
		<div className="flex items-center gap-2">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onChange(next === true)}
			/>
			<label htmlFor={id} className="text-xs text-muted-foreground">
				{label}
			</label>
		</div>
	)
}

const Divider = () => <div className="h-px bg-border" />

function Name() {
	const { state, set } = useSettings()
	return (
		<Field label="Name">
			<Input
				value={state.title}
				onChange={(event) => set({ title: event.target.value })}
				placeholder="Untitled widget"
			/>
		</Field>
	)
}

function Description() {
	const { state, set } = useSettings()
	return (
		<Field label="Description">
			<Textarea
				value={state.description}
				onChange={(event) => set({ description: event.target.value })}
				placeholder="Add a description..."
				rows={2}
			/>
		</Field>
	)
}

function TypePicker() {
	const { state, set } = useSettings()
	const panelType = toPanelType(state.visualization, state.chartId)
	return (
		<Field label="Type">
			{/* Three columns, not four: "Histogram" overflows a quarter of the
			    272px rail and collides with its neighbour. */}
			<div className="grid grid-cols-3 gap-1 rounded-md border bg-muted/40 p-1">
				{PANEL_TYPES.map((option) => (
					<button
						key={option.value}
						type="button"
						onClick={() => set(fromPanelType(option.value, state.chartId))}
						aria-pressed={panelType === option.value}
						className={cn(
							"h-7 rounded-sm text-xs transition-colors",
							panelType === option.value
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				))}
			</div>
		</Field>
	)
}

/** Bar and area charts choose between grouped/overlapping series and stacked. */
function Stacked() {
	const { state, set } = useSettings()
	const panelType = toPanelType(state.visualization, state.chartId)
	return (
		<Field label="Layout">
			<Segments
				value={state.stacked ? "stacked" : "separate"}
				onSelect={(next) => set({ stacked: next === "stacked" })}
				options={[
					{ value: "separate", label: panelType === "bar" ? "Grouped" : "Overlapping" },
					{ value: "stacked", label: "Stacked" },
				]}
			/>
		</Field>
	)
}

function Curve() {
	const { state, set } = useSettings()
	return (
		<Field label="Curve">
			<Segments
				value={state.curveType}
				onSelect={(curveType) => set({ curveType })}
				options={[
					{ value: "linear", label: "Linear" },
					{ value: "monotone", label: "Smooth" },
				]}
			/>
		</Field>
	)
}

const titleCase = (value: string) => value[0]!.toUpperCase() + value.slice(1)

/** The ramp itself, so picking a palette is a visual choice rather than a word. */
function RampSwatch({ scale }: { scale: HeatmapColorScale }) {
	return (
		<span className="flex shrink-0 gap-px">
			{[0, 1, 2, 3, 4].map((stop) => (
				<span
					key={stop}
					className="size-2 rounded-[2px]"
					style={{ backgroundColor: `var(--heatmap-${scale}-${stop})` }}
				/>
			))}
		</span>
	)
}

function HeatmapColors() {
	const { state, set } = useSettings()
	return (
		<>
			<Field label="Color scale">
				<Select
					items={Object.fromEntries(HEATMAP_COLOR_SCALES.map((scale) => [scale, titleCase(scale)]))}
					value={state.heatmapColorScale}
					onValueChange={(value) =>
						set({ heatmapColorScale: value as typeof state.heatmapColorScale })
					}
				>
					<SelectTrigger className="w-full">
						<span className="flex items-center gap-2">
							<RampSwatch scale={state.heatmapColorScale} />
							<SelectValue />
						</span>
					</SelectTrigger>
					<SelectContent>
						{HEATMAP_COLOR_SCALES.map((scale) => (
							<SelectItem key={scale} value={scale}>
								<span className="flex items-center gap-2">
									<RampSwatch scale={scale} />
									{titleCase(scale)}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			<Field label="Color scaling">
				<Segments
					value={state.heatmapScaleType}
					onSelect={(heatmapScaleType) => set({ heatmapScaleType })}
					options={[
						{ value: "linear", label: "Linear" },
						{ value: "log", label: "Log" },
					]}
				/>
			</Field>
		</>
	)
}

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

const DURATION_SCALE_OPTIONS = [
	{ value: "duration_ns" as ValueUnit, label: "ns" },
	{ value: "duration_us" as ValueUnit, label: "us" },
	{ value: "duration_ms" as ValueUnit, label: "ms" },
	{ value: "duration_s" as ValueUnit, label: "s" },
]

const isDurationUnit = (value: string) => value.startsWith("duration_")

/** Charts label this "Y-Axis Unit"; scalar widgets just "Unit". */
function Unit({ label = "Unit" }: { label?: string }) {
	const { state, set } = useSettings()
	const isDuration = isDurationUnit(state.unit)
	return (
		<Field label={label}>
			<Select
				items={UNIT_OPTIONS}
				value={isDuration ? "duration" : state.unit}
				onValueChange={(value) =>
					set({ unit: value === "duration" ? "duration_ms" : (value as ValueUnit) })
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
			{isDuration && (
				<Segments
					value={state.unit as ValueUnit}
					onSelect={(unit) => set({ unit })}
					options={DURATION_SCALE_OPTIONS}
				/>
			)}
		</Field>
	)
}

/**
 * `seriesStats` is the Min/Max/Mean/Last table, which only time-series legends
 * render — a categorical legend (pie) has one value per row and nothing to
 * reduce over time, so those panels pass `seriesStats={false}`.
 */
function Legend({ seriesStats = true }: { seriesStats?: boolean }) {
	const { state, set } = useSettings()
	return (
		<Field label="Legend">
			<Segments
				value={state.legendPosition}
				onSelect={(legendPosition) => set({ legendPosition })}
				options={[
					{ value: "bottom", label: "Bottom" },
					{ value: "right", label: "Right" },
					{ value: "hidden", label: "Hidden" },
				]}
			/>
			{seriesStats && (
				<div className="pt-0.5">
					<CheckboxRow
						id="qb-series-stats"
						label="Show Min/Max/Mean/Last stats"
						checked={state.seriesStatsEnabled}
						onChange={(checked) =>
							// Stats live inside the legend, so enabling them with the legend
							// hidden would have no visible effect — turn the legend on
							// (bottom) in the same change.
							set(
								checked && state.legendPosition === "hidden"
									? { seriesStatsEnabled: true, legendPosition: "bottom" }
									: { seriesStatsEnabled: checked },
							)
						}
					/>
				</div>
			)}
		</Field>
	)
}

const STAT_AGGREGATES: StatAggregate[] = ["first", "sum", "count", "avg", "max", "min"]

/** How the timeseries a stat or gauge reads is reduced to one number. */
function ScalarReduction() {
	const { state, seriesFieldOptions, set } = useSettings()
	// A widget whose queries changed can hold a value field that no longer
	// exists; fall back to the first series so the select is never blank.
	const valueField =
		seriesFieldOptions.length > 0 &&
		(!state.statValueField || !seriesFieldOptions.includes(state.statValueField))
			? seriesFieldOptions[0]
			: state.statValueField

	return (
		<>
			<Field label="Aggregate">
				<Select
					items={Object.fromEntries(STAT_AGGREGATES.map((value) => [value, value]))}
					value={state.statAggregate}
					onValueChange={(value) => set({ statAggregate: value as StatAggregate })}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{STAT_AGGREGATES.map((value) => (
							<SelectItem key={value} value={value}>
								{value}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			<Field label="Value Field">
				<Select
					value={valueField || seriesFieldOptions[0]}
					onValueChange={(value) => set({ statValueField: value ?? "" })}
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
			</Field>
		</>
	)
}

function GaugeRange() {
	const { state, set } = useSettings()
	return (
		<div className="grid grid-cols-2 gap-2">
			<Field label="Min">
				<Input
					type="number"
					value={state.gaugeMin}
					onChange={(event) => set({ gaugeMin: event.target.value })}
					placeholder="0"
				/>
			</Field>
			<Field label="Max">
				<Input
					type="number"
					value={state.gaugeMax}
					onChange={(event) => set({ gaugeMax: event.target.value })}
					placeholder="100"
				/>
			</Field>
		</div>
	)
}

/**
 * The sparkline embeds a second data source built from the query-builder state,
 * so in Raw SQL mode it would fetch the placeholder queries rather than the
 * user's SQL. Offer it only where it can be honest.
 */
function Sparkline() {
	const { state, sourceMode, set } = useSettings()
	if (sourceMode !== "builder") return null
	return (
		<CheckboxRow
			id="qb-sparkline"
			label="Show sparkline"
			checked={state.sparklineEnabled}
			onChange={(sparklineEnabled) => set({ sparklineEnabled })}
		/>
	)
}

function Thresholds() {
	const { state, set } = useSettings()
	const thresholds = state.thresholds
	const replace = (next: typeof thresholds) => set({ thresholds: next })

	return (
		<Field label="Thresholds">
			<div className="flex flex-col gap-1.5">
				{thresholds.map((threshold, index) => (
					// eslint-disable-next-line react/no-array-index-key -- thresholds have no stable id
					<div key={index} className="flex items-center gap-1.5">
						<input
							type="color"
							value={threshold.color.startsWith("#") ? threshold.color : "#ef4444"}
							onChange={(event) =>
								replace(
									thresholds.map((current, i) =>
										i === index ? { ...current, color: event.target.value } : current,
									),
								)
							}
							className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
							aria-label="Threshold color"
						/>
						<Input
							type="number"
							value={String(threshold.value)}
							onChange={(event) => {
								const parsed = Number(event.target.value)
								replace(
									thresholds.map((current, i) =>
										i === index
											? { ...current, value: Number.isFinite(parsed) ? parsed : 0 }
											: current,
									),
								)
							}}
							className="h-8"
						/>
						<button
							type="button"
							onClick={() => replace(thresholds.filter((_, i) => i !== index))}
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded border text-muted-foreground transition-colors hover:text-foreground"
							aria-label="Remove threshold"
						>
							×
						</button>
					</div>
				))}
				<button
					type="button"
					onClick={() => replace([...thresholds, { value: 0, color: "#ef4444" }])}
					className="h-8 rounded-md border border-dashed text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					+ Add threshold
				</button>
			</div>
		</Field>
	)
}

function RowLimit() {
	const { state, set } = useSettings()
	return (
		<Field label="Row Limit">
			<Input
				value={state.tableLimit}
				onChange={(event) => set({ tableLimit: event.target.value })}
				placeholder="50"
				type="number"
				min={1}
			/>
		</Field>
	)
}

/**
 * Settings shared by every query-driven panel type. Lists and notes don't run a
 * query-builder query, so they omit this block entirely.
 */
function QueryOptions() {
	const { state, set } = useSettings()
	return (
		<>
			<Divider />
			<Field label="Comparison">
				<Select
					items={{ none: "None", previous_period: "Previous period" }}
					value={state.comparisonMode}
					onValueChange={(value) =>
						set({ comparisonMode: value === "previous_period" ? "previous_period" : "none" })
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
			</Field>
			<Divider />
			<div className="flex flex-col gap-3">
				<CheckboxRow
					id="qb-percent-change"
					label="% change"
					checked={state.includePercentChange}
					disabled={state.comparisonMode === "none"}
					onChange={(includePercentChange) => set({ includePercentChange })}
				/>
				<CheckboxRow
					id="qb-debug"
					label="Debug"
					checked={state.debug}
					onChange={(debug) => set({ debug })}
				/>
			</div>
		</>
	)
}

/**
 * Pins the widget to a window of its own instead of the dashboard's — the
 * "Active in the last 30 minutes" tile on a board scoped to the last 7 days.
 * Notes never query, so they don't offer it.
 *
 * A relative override ("30m") rebases against "now" on every dashboard refresh,
 * exactly like the board's own relative range; an absolute one stays put.
 */
function WidgetTimeRange() {
	const { state, set } = useSettings()
	const {
		state: { resolvedTimeRange: dashboardResolved },
	} = useDashboardTimeRange()

	if (state.visualization === "markdown") return null

	const override = state.timeRange
	const resolved = override ? resolveTimeRange(override) : null

	return (
		<Field label="Time range">
			<div className="space-y-1.5">
				<Segments
					value={override ? "custom" : "dashboard"}
					onSelect={(next) =>
						set({
							// Seed a new override from whatever the board is showing, so the
							// tile doesn't jump to some unrelated window the moment you
							// detach it.
							timeRange:
								next === "dashboard"
									? null
									: dashboardResolved
										? {
												type: "absolute",
												startTime: dashboardResolved.startTime,
												endTime: dashboardResolved.endTime,
											}
										: { type: "relative", value: "1h" },
						})
					}
					options={[
						{ value: "dashboard", label: "Dashboard" },
						{ value: "custom", label: "Custom" },
					]}
				/>
				{override && (
					<TimeRangePicker
						startTime={resolved?.startTime}
						endTime={resolved?.endTime}
						presetValue={override.type === "relative" ? override.value : undefined}
						onChange={(range) => {
							if (!range.startTime || !range.endTime) return
							set({
								timeRange: range.presetValue
									? { type: "relative", value: range.presetValue }
									: {
											type: "absolute",
											startTime: range.startTime,
											endTime: range.endTime,
										},
							})
						}}
					/>
				)}
			</div>
		</Field>
	)
}

/**
 * The rail's field vocabulary. A panel type's `ConfigPanel` composes these; none
 * of them takes the widget state as a prop.
 */
export const WidgetSettings = {
	Divider,
	Name,
	Description,
	TimeRange: WidgetTimeRange,
	TypePicker,
	Stacked,
	Curve,
	HeatmapColors,
	Unit,
	Legend,
	ScalarReduction,
	GaugeRange,
	Sparkline,
	Thresholds,
	RowLimit,
	QueryOptions,
}
