import {
	useDeferredValue,
	useMemo,
	useState,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
} from "react"
import type { AlertComparator, AlertSeverity, AlertSignalType } from "@maple/domain/http"

import { Card } from "@maple/ui/components/ui/card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"

import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"
import { SectionHeader } from "@/components/layout/section-header"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { RawSqlEditorPanel } from "@/components/dashboard-builder/config/raw-sql-editor-panel"
import {
	BoltIcon,
	BracketsCurlyIcon,
	ChartLineIcon,
	ChevronDownIcon,
	CircleWarningIcon,
	CirclePercentageIcon,
	FireIcon,
	PulseIcon,
	SlidersIcon,
} from "@/components/icons"
import type { AutocompleteValuesContextType } from "@/hooks/use-autocomplete-values"
import {
	comparatorLabels,
	isRangeComparator,
	RAW_QUERY_REDUCER_LABELS,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	buildTimeseriesQuerySpec,
	resetAggregationForMetricType,
	resetQueryForDataSource,
	type QueryBuilderDataSource,
	type QueryBuilderQueryDraft,
} from "@maple/query-engine/query-builder"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { listMetricsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

interface SignalAndThresholdSectionProps {
	form: RuleFormState
	onChange: Dispatch<SetStateAction<RuleFormState>>
	autocompleteValues: AutocompleteValuesContextType
}

/* Seven signal types is too many for a single segmented bar — they wrap and
   every option looks equally weighted even though five of them are "I want a
   common metric" and the other two are "I'll define my own". We split the
   choice into two tiers:
     - Tier 1 (always visible): the *kind* of signal — built-in, query builder,
       or raw SQL.
     - Tier 2 (only when "built-in" is active): which of the five canned
       metrics to watch.
   The mapping back to `AlertSignalType` happens in `signalTypeToKind` and the
   default-on-kind-switch logic in `setKind`. */
type SignalKind = "builtin" | "builder_query" | "raw_query"

function signalTypeToKind(signalType: AlertSignalType): SignalKind {
	if (signalType === "builder_query") return "builder_query"
	if (signalType === "raw_query") return "raw_query"
	return "builtin"
}

/* Strip the browser's native number-input spin buttons. Applied to every
   numeric input on the page — we don't want the ▲▼ overlay competing with the
   form's clean monospace numerals. Lives as a const so the Tailwind arbitrary
   selectors stay readable and we can add it consistently everywhere. */
const NUMERIC_INPUT_CLASS =
	"font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"

const SIGNAL_KIND_OPTIONS: ReadonlyArray<{
	value: SignalKind
	label: string
	icon: ReactNode
}> = [
	{ value: "builtin", label: "Built-in", icon: <BoltIcon className="size-3" /> },
	{ value: "builder_query", label: "Query", icon: <SlidersIcon className="size-3" /> },
	{ value: "raw_query", label: "Raw SQL", icon: <BracketsCurlyIcon className="size-3" /> },
]

/* The "built-in" tier-2 row: 5 small chips with icons. Icons are deliberately
   reused from the templates overlay so the picker visually rhymes with the
   first-touch flow. Each signal also carries its own brand color drawn from
   the chart-* CSS variables, so the chip's tint matches the series color the
   live chart paints when that signal is selected. */
const BUILTIN_SIGNAL_OPTIONS: ReadonlyArray<{
	value: AlertSignalType
	label: string
	icon: (props: { size?: number; className?: string }) => ReactNode
	/** Applied to the chip's container when selected (border + bg). */
	selectedClass: string
	/** Applied to the icon at all times so the *unselected* chips still hint
	    at their identity with a colored glyph (think: a muted version of the
	    selected state). */
	iconClass: string
}> = [
	{
		value: "error_rate",
		label: "Error rate",
		icon: FireIcon,
		selectedClass: "border-chart-error/50 bg-chart-error/10 text-foreground",
		iconClass: "text-chart-error",
	},
	{
		value: "p95_latency",
		label: "P95",
		icon: ChartLineIcon,
		selectedClass: "border-chart-p95/50 bg-chart-p95/10 text-foreground",
		iconClass: "text-chart-p95",
	},
	{
		value: "p99_latency",
		label: "P99",
		icon: ChartLineIcon,
		selectedClass: "border-chart-p99/50 bg-chart-p99/10 text-foreground",
		iconClass: "text-chart-p99",
	},
	{
		value: "apdex",
		label: "Apdex",
		icon: CirclePercentageIcon,
		selectedClass: "border-chart-apdex/50 bg-chart-apdex/10 text-foreground",
		iconClass: "text-chart-apdex",
	},
	{
		value: "throughput",
		label: "Throughput",
		icon: PulseIcon,
		selectedClass: "border-chart-throughput/50 bg-chart-throughput/10 text-foreground",
		iconClass: "text-chart-throughput",
	},
]

const COMPARATOR_OPTIONS: ReadonlyArray<{ value: AlertComparator; label: string }> = (
	Object.keys(comparatorLabels) as AlertComparator[]
).map((value) => ({ value, label: comparatorLabels[value] }))

/* Severity is rendered with branded color (amber / destructive-red) instead of
   the default neutral segmented toggle, because severity is the one field on
   the page that should *feel* like its outcome. */
const SEVERITY_OPTIONS: ReadonlyArray<{
	value: AlertSeverity
	label: string
	selectedClass: string
	dotClass: string
}> = [
	{
		value: "warning",
		label: "Warning",
		selectedClass:
			"border-severity-warn/60 bg-severity-warn/10 text-severity-warn hover:bg-severity-warn/15 focus-visible:ring-severity-warn/40",
		dotClass:
			"bg-severity-warn shadow-[0_0_0_2px_color-mix(in_oklch,var(--severity-warn)_25%,transparent)]",
	},
	{
		value: "critical",
		label: "Critical",
		selectedClass:
			"border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/15 focus-visible:ring-destructive/40",
		dotClass: "bg-destructive shadow-[0_0_0_2px_color-mix(in_oklch,var(--destructive)_25%,transparent)]",
	},
]

export function SignalAndThresholdSection({
	form,
	onChange,
	autocompleteValues,
}: SignalAndThresholdSectionProps) {
	const rangeMode = isRangeComparator(form.comparator)
	// error_rate thresholds are entered as a percent (the form↔domain helpers in
	// form-utils convert to/from the stored 0–1 ratio).
	const isErrorRate = form.signalType === "error_rate"
	// Builder-query thresholds compare against the query's raw output — for an
	// error_rate aggregation that's the engine's 0–1 ratio, so surface the unit
	// to head off "5 means 5%" mistakes (5 would mean a 500% error rate).
	const isBuilderErrorRate =
		form.signalType === "builder_query" && form.queryBuilderDraft.aggregation === "error_rate"
	const [advancedOpen, setAdvancedOpen] = useState(false)

	const kind = signalTypeToKind(form.signalType)

	/* Switching tier-1 has to seed a valid signalType for the new kind.
	   Built-in defaults to error_rate; the other three map 1:1 since
	   AlertSignalType already has matching string values. */
	function setKind(next: SignalKind) {
		if (next === kind) return
		onChange((c) => ({
			...c,
			signalType:
				next === "builtin"
					? "error_rate"
					: (next as Exclude<SignalKind, "builtin"> & AlertSignalType),
		}))
	}

	return (
		<Card className="p-4">
			<SectionHeader id="rule-signal-heading" label="Signal & threshold" />

			<div className="space-y-4">
				{/* Tier 1: signal kind. Always visible. */}
				<AlertSegmentedSelect<SignalKind>
					options={SIGNAL_KIND_OPTIONS}
					value={kind}
					onChange={setKind}
					aria-label="Signal kind"
					size="sm"
					className="[&_[data-pressed]_svg]:opacity-100 [&_[data-slot=toggle]]:gap-1.5"
				/>

				{/* Tier 2: only for built-ins. Icon chips, single short row. */}
				{kind === "builtin" && (
					<BuiltinSignalChips
						value={form.signalType}
						onChange={(value) => onChange((c) => ({ ...c, signalType: value }))}
					/>
				)}

				<SignalSubConfig form={form} onChange={onChange} autocompleteValues={autocompleteValues} />

				{/* Threshold row — comparator + value(s). Upper threshold stays mounted but
				    disabled outside range mode so the grid never reflows. The
				    `min-w-0` on every grid child overrides the Select's baked-in
				    `min-w-36` so a narrow Condition column doesn't push its
				    chevron into the next field. */}
				<div className="grid gap-3 sm:grid-cols-[140px_1fr_1fr]">
					<div className="min-w-0 space-y-1.5">
						<Label htmlFor="rule-comparator">Condition</Label>
						<Select
							items={comparatorLabels}
							value={form.comparator}
							onValueChange={(value) =>
								onChange((c) => ({ ...c, comparator: value as AlertComparator }))
							}
						>
							<SelectTrigger id="rule-comparator" className="w-full min-w-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{COMPARATOR_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="min-w-0 space-y-1.5">
						<Label htmlFor="rule-threshold">
							{rangeMode ? "Lower" : "Threshold"}
							{isErrorRate && <span className="text-muted-foreground"> (%)</span>}
							{isBuilderErrorRate && (
								<span className="text-muted-foreground"> (0–1 ratio, 0.05 = 5%)</span>
							)}
						</Label>
						<Input
							id="rule-threshold"
							type="number"
							inputMode="decimal"
							value={form.threshold}
							onChange={(e) => onChange((c) => ({ ...c, threshold: e.target.value }))}
							className={NUMERIC_INPUT_CLASS}
							placeholder="0"
						/>
					</div>
					<div className="min-w-0 space-y-1.5">
						<Label
							htmlFor="rule-threshold-upper"
							className={cn(!rangeMode && "text-muted-foreground/60")}
						>
							Upper
							{isErrorRate && <span className="text-muted-foreground"> (%)</span>}
							{isBuilderErrorRate && (
								<span className="text-muted-foreground"> (0–1 ratio)</span>
							)}
						</Label>
						<Input
							id="rule-threshold-upper"
							type="number"
							inputMode="decimal"
							value={form.thresholdUpper}
							onChange={(e) => onChange((c) => ({ ...c, thresholdUpper: e.target.value }))}
							disabled={!rangeMode}
							className={NUMERIC_INPUT_CLASS}
							placeholder={rangeMode ? "0" : "—"}
						/>
					</div>
				</div>

				{/* Severity inline — branded pills, not neutral toggle. */}
				<div className="flex items-center justify-between gap-3">
					<Label id="rule-severity-label">Severity</Label>
					<SeverityToggle
						value={form.severity}
						onChange={(value) => onChange((c) => ({ ...c, severity: value }))}
					/>
				</div>

				{/* Advanced timing — collapsed by default. Most users never tune these. */}
				<div className="border-t pt-3">
					<button
						type="button"
						onClick={() => setAdvancedOpen((o) => !o)}
						className="flex w-full items-center justify-between gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
						aria-expanded={advancedOpen}
					>
						<span className="font-medium uppercase tracking-wide">Evaluation timing</span>
						<span className="flex items-center gap-1.5">
							<span className="font-mono">
								{form.windowMinutes}min · {form.consecutiveBreachesRequired}× · renotify{" "}
								{form.renotifyIntervalMinutes}min
							</span>
							<ChevronDownIcon
								size={12}
								className={cn("transition-transform", advancedOpen && "rotate-180")}
							/>
						</span>
					</button>
					{advancedOpen && (
						<div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							<NumericField
								id="rule-window-minutes"
								label="Window (min)"
								hint="Aggregate window each check."
								value={form.windowMinutes}
								onChange={(value) => onChange((c) => ({ ...c, windowMinutes: value }))}
							/>
							<NumericField
								id="rule-consecutive-breaches"
								label="Breaches to fire"
								hint="Consecutive breaches required."
								value={form.consecutiveBreachesRequired}
								onChange={(value) =>
									onChange((c) => ({
										...c,
										consecutiveBreachesRequired: value,
									}))
								}
							/>
							<NumericField
								id="rule-consecutive-healthy"
								label="Healthy to resolve"
								hint="Consecutive healthy checks required."
								value={form.consecutiveHealthyRequired}
								onChange={(value) =>
									onChange((c) => ({
										...c,
										consecutiveHealthyRequired: value,
									}))
								}
							/>
							<NumericField
								id="rule-minimum-samples"
								label="Min samples"
								hint="Skip below this count."
								value={form.minimumSampleCount}
								onChange={(value) => onChange((c) => ({ ...c, minimumSampleCount: value }))}
							/>
							<NumericField
								id="rule-renotify"
								label="Renotify (min)"
								hint="Repeat cadence."
								value={form.renotifyIntervalMinutes}
								onChange={(value) =>
									onChange((c) => ({
										...c,
										renotifyIntervalMinutes: value,
									}))
								}
							/>
						</div>
					)}
				</div>
			</div>
		</Card>
	)
}

/**
 * Tier-2 picker for the five built-in signals. Renders as small icon chips
 * inside a subtly tinted rail so the visual relationship to the tier-1 bar
 * above reads as "drill-in", not "another peer choice".
 */
function BuiltinSignalChips({
	value,
	onChange,
}: {
	value: AlertSignalType
	onChange: (next: AlertSignalType) => void
}) {
	return (
		<div className="-mt-1 flex flex-col gap-1.5">
			<div
				role="radiogroup"
				aria-label="Built-in signal"
				className="flex flex-wrap items-center gap-1 rounded-md border border-dashed border-border/60 bg-muted/20 p-1"
				data-slot="builtin-signal-chips"
			>
				{BUILTIN_SIGNAL_OPTIONS.map((opt) => {
					const selected = value === opt.value
					const Icon = opt.icon
					return (
						<button
							key={opt.value}
							type="button"
							role="radio"
							aria-checked={selected}
							onClick={() => onChange(opt.value)}
							className={cn(
								"inline-flex h-7 items-center gap-1.5 rounded-sm border border-transparent px-2 text-xs font-medium",
								"transition-[background-color,border-color,color] duration-150",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
								selected
									? opt.selectedClass
									: "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
							)}
						>
							<Icon
								size={12}
								className={cn(
									"transition-opacity",
									opt.iconClass,
									selected ? "opacity-100" : "opacity-70",
								)}
							/>
							{opt.label}
						</button>
					)
				})}
			</div>
			<p className="text-[11px] leading-snug text-muted-foreground">
				Built-in signals measure entry-point (root) spans only. A service that records failures on
				child spans and returns success from its entry point — cron jobs and workers typically do —
				stays healthy here at any threshold. Use Raw SQL for those, or rely on error notifications.
			</p>
		</div>
	)
}

/**
 * Inline severity picker — two pills side by side that adopt the severity's
 * brand color when selected (amber for warning, red for critical). Designed
 * to be the most visually deliberate control on the form, since severity is
 * the one knob that actually changes who hears about a breach.
 */
function SeverityToggle({
	value,
	onChange,
}: {
	value: AlertSeverity
	onChange: (next: AlertSeverity) => void
}) {
	return (
		<div
			role="radiogroup"
			aria-labelledby="rule-severity-label"
			className="inline-flex items-center gap-1 rounded-md bg-muted/30 p-0.5"
		>
			{SEVERITY_OPTIONS.map((opt) => {
				const selected = value === opt.value
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(opt.value)}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-transparent px-2.5 text-xs font-medium",
							"transition-[background-color,border-color,color] duration-150",
							// `ring-ring` is the base so an unselected pill still shows a focus
							// ring; the selected variants override it with their brand color.
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
							selected ? opt.selectedClass : "text-muted-foreground hover:text-foreground",
						)}
					>
						<span
							aria-hidden
							className={cn(
								"size-1.5 rounded-full transition-shadow",
								selected ? opt.dotClass : "bg-muted-foreground/40",
							)}
						/>
						{opt.label}
					</button>
				)
			})}
		</div>
	)
}

function NumericField({
	id,
	label,
	hint,
	value,
	onChange,
}: {
	id: string
	label: string
	hint?: string
	value: string
	onChange: (value: string) => void
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				min={0}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className={NUMERIC_INPUT_CLASS}
			/>
			{hint && <p className="text-muted-foreground text-xs">{hint}</p>}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/*  Signal-specific sub-config                                                */
/* -------------------------------------------------------------------------- */

type MetricRow = {
	metricName: string
	metricType: string
	serviceName: string
	isMonotonic: boolean
}

function useAlertMetricSelectionOptions(query: QueryBuilderQueryDraft) {
	const [metricSearch, setMetricSearch] = useState("")
	const deferredMetricSearch = useDeferredValue(metricSearch)
	const metricsResult = useAtomValue(
		query.dataSource === "metrics"
			? listMetricsResultAtom({ data: { limit: 100, search: deferredMetricSearch || undefined } })
			: disabledResultAtom(),
	)

	const metricRows = useMemo(
		(): MetricRow[] =>
			Result.builder(metricsResult)
				.onSuccess((response) => (response as { data: MetricRow[] }).data)
				.orElse(() => []),
		[metricsResult],
	)

	const metricSelectionOptions = useMemo(() => {
		const seen = new Set<string>()
		const options: Array<{ value: string; label: string; isMonotonic: boolean }> = []
		for (const row of metricRows) {
			if (
				row.metricType !== "sum" &&
				row.metricType !== "gauge" &&
				row.metricType !== "histogram" &&
				row.metricType !== "exponential_histogram"
			) {
				continue
			}
			const value = `${row.metricName}::${row.metricType}`
			if (seen.has(value)) continue
			seen.add(value)
			options.push({
				value,
				label: `${row.metricName} (${row.metricType})`,
				isMonotonic: row.isMonotonic,
			})
		}
		return options
	}, [metricRows])

	return { metricSelectionOptions, setMetricSearch }
}

function AlertQueryPanel({ form, onChange, autocompleteValues }: SignalAndThresholdSectionProps) {
	const query = form.queryBuilderDraft
	const warnings = useMemo(() => buildTimeseriesQuerySpec(query).warnings, [query])
	const { metricSelectionOptions, setMetricSearch } = useAlertMetricSelectionOptions(query)

	const updateQuery = (updater: (query: QueryBuilderQueryDraft) => QueryBuilderQueryDraft) => {
		onChange((current) => ({
			...current,
			queryBuilderDraft: updater(current.queryBuilderDraft),
		}))
	}

	return (
		<div className="space-y-2">
			<QueryPanel
				query={query}
				index={0}
				canRemove={false}
				metricSelectionOptions={metricSelectionOptions}
				onMetricSearch={setMetricSearch}
				autocompleteValues={autocompleteValues}
				onUpdate={updateQuery}
				onAggregationChange={(aggregation) => updateQuery((current) => ({ ...current, aggregation }))}
				onMetricSelectionChange={(selection) =>
					updateQuery((current) =>
						current.dataSource === "metrics"
							? {
									...current,
									metricName: selection.metricName,
									metricType: selection.metricType,
									isMonotonic: selection.isMonotonic,
									aggregation: resetAggregationForMetricType(
										current.aggregation,
										selection.metricType,
										selection.isMonotonic,
									),
								}
							: current,
					)
				}
				onClone={() => {}}
				onRemove={() => {}}
				onDataSourceChange={(dataSource: QueryBuilderDataSource) =>
					updateQuery((current) => resetQueryForDataSource(current, dataSource))
				}
				showHeaderActions={false}
				showVisibilityToggle={false}
			/>
			{warnings.length > 0 && (
				<div className="flex gap-2 border border-warning/30 bg-warning/10 p-2 text-xs text-warning-foreground">
					<CircleWarningIcon size={14} className="mt-0.5 shrink-0" />
					<ul className="space-y-1">
						{warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</div>
			)}
		</div>
	)
}

function SignalSubConfig({ form, onChange, autocompleteValues }: SignalAndThresholdSectionProps) {
	switch (form.signalType) {
		case "apdex":
			return (
				<div className="flex items-end gap-3">
					<div className="space-y-1.5">
						<Label htmlFor="apdex-threshold">Apdex target (ms)</Label>
						<Input
							id="apdex-threshold"
							type="number"
							value={form.apdexThresholdMs}
							onChange={(e) => onChange((c) => ({ ...c, apdexThresholdMs: e.target.value }))}
							className={cn("w-[180px]", NUMERIC_INPUT_CLASS)}
						/>
					</div>
					<p className="text-muted-foreground pb-2 text-xs">
						Requests under this duration count as fully satisfied.
					</p>
				</div>
			)

		case "builder_query":
			return <AlertQueryPanel form={form} onChange={onChange} autocompleteValues={autocompleteValues} />

		case "raw_query":
			return (
				<div className="space-y-3">
					<RawSqlEditorPanel
						draft={{ sql: form.rawQuerySql, granularitySeconds: null }}
						onDraftChange={(draft) =>
							onChange((current) => ({ ...current, rawQuerySql: draft.sql }))
						}
						showBucketControl={false}
						targetLabel="alert rule"
					/>
					<p className="text-muted-foreground text-xs">
						Alert SQL must return a numeric <code>value</code> column.
					</p>
					<div className="flex items-end gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="rule-raw-reducer">Reduce buckets by</Label>
							<Select
								items={RAW_QUERY_REDUCER_LABELS}
								value={form.rawQueryReducer}
								onValueChange={(value) =>
									value &&
									onChange((c) => ({
										...c,
										rawQueryReducer: value as RuleFormState["rawQueryReducer"],
									}))
								}
							>
								<SelectTrigger id="rule-raw-reducer" className="w-[180px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(RAW_QUERY_REDUCER_LABELS).map(([val, label]) => (
										<SelectItem key={val} value={val}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>
			)

		default:
			return null
	}
}
