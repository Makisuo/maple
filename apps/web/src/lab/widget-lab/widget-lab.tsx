import { useMemo, useState, type ReactNode } from "react"

import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { CopyableValue } from "@maple/ui/components/attributes"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { LinkIcon } from "@/components/icons"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import type { WidgetMode } from "@/components/dashboard-builder/types"

import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import {
	ChartWidget,
	FunnelWidget,
	HbarWidget,
	HeatmapWidget,
	HistogramWidget,
	PieWidget,
} from "@/components/dashboard-builder/widgets/make-chart-widget"
import { SparklineSeriesScope } from "@/components/dashboard-builder/widgets/stat-widget"
import { WidgetActionsScope } from "@/components/dashboard-builder/widgets/widget-actions-context"
import { widgetTypes } from "@/components/dashboard-builder/widgets/types"

const { gauge, list, markdown, stat, table } = widgetTypes
const GaugeWidget = gauge.Renderer
const ListWidget = list.Renderer
const MarkdownWidget = markdown.Renderer
const StatWidget = stat.Renderer
const TableWidget = table.Renderer

import {
	statScenarios,
	statSparklineScenarios,
	gaugeScenarios,
	sparklineSamples,
	chartScenarios,
	stressScenarios,
	tableScenarios,
	listScenarios,
	pieScenarios,
	funnelScenarios,
	hbarScenarios,
	histogramScenarios,
	heatmapScenarios,
	markdownScenarios,
	type WidgetScenario,
	type StatSparklineScenario,
	type ChartScenario,
} from "@/lab/widget-lab/scenarios"
import { makeQueryDataSource } from "@maple/widgets/dashboard"

// Widget renderers take no action props — the card menu resolves them from
// context. The lab renders outside a dashboard, so it supplies its own stubs.
const labActions = {
	remove: () => console.log("[widget-lab] remove"),
	clone: () => console.log("[widget-lab] clone"),
	configure: () => console.log("[widget-lab] configure"),
	fix: () => console.log("[widget-lab] fix"),
}

interface ScenarioCellProps {
	label: string
	height?: number
	children: ReactNode
}

function ScenarioCell({ label, height = 320, children }: ScenarioCellProps) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
				{label}
			</span>
			<div className="w-full" style={{ height }}>
				{children}
			</div>
		</div>
	)
}

interface SectionProps {
	id: string
	title: string
	description: string
	minColWidth?: number
	children: ReactNode
}

function Section({ id, title, description, minColWidth = 320, children }: SectionProps) {
	return (
		<section id={id} className="flex flex-col gap-3 scroll-mt-20">
			<div className="flex flex-col gap-0.5">
				<h2 className="text-lg font-semibold">{title}</h2>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<div
				className="grid gap-4"
				style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${minColWidth}px,1fr))` }}
			>
				{children}
			</div>
		</section>
	)
}

/** Every shape `CopyButton` is asked to take across the product, side by side. */
function CopyScenarios() {
	const rows: Array<{ label: string; node: ReactNode }> = [
		{ label: "icon-xs / ghost (default)", node: <CopyButton value="trace-abc123" label="Trace ID" /> },
		{
			label: "tooltip",
			node: <CopyButton value="9f2c1a" label="Commit SHA" tooltip />,
		},
		{
			label: "link glyph",
			node: <CopyButton value="https://maple.dev" label="Link" idleIcon={LinkIcon} tooltip />,
		},
		{
			label: "with label / outline",
			node: <CopyButton value="npm i @maple/cli" label="Command" idleLabel="Copy" variant="outline" />,
		},
		{
			label: "with label / long copied text",
			node: (
				<CopyButton
					value="https://maple.dev/share/xyz"
					label="Link"
					idleLabel="Copy link"
					copiedLabel="Copied link"
					variant="outline"
				/>
			),
		},
		{
			label: "icon-sm / outline",
			node: <CopyButton value="key_live_x" label="API key" size="icon-sm" variant="outline" />,
		},
		{
			// A resolver that throws (a circular `JSON.stringify`, say) must surface as
			// the error state, not an uncaught click handler.
			label: "error branch (10s hold)",
			node: (
				<CopyButton
					value={() => {
						throw new Error("unserializable")
					}}
					label="Broken value"
					tooltip
					timeout={10_000}
				/>
			),
		},
		{
			// Long hold so the copied state can actually be inspected — the default 2s
			// is gone before you can look at it.
			label: "10s hold (inspect the copied state)",
			node: (
				<CopyButton
					value="hold-me"
					label="Held value"
					idleLabel="Copy"
					variant="outline"
					timeout={10_000}
				/>
			),
		},
		{
			// Everything toasts by default; this is the opt-out for surfaces where a
			// toast per click would pile up.
			label: "toast={false} (opt-out)",
			node: (
				<CopyButton
					value="issue_123"
					label="Issue ID"
					toast={false}
					idleLabel="Copy"
					variant="outline"
				/>
			),
		},
		{ label: "disabled", node: <CopyButton value="x" label="Nothing" disabled /> },
		{
			// The app's most-used copy affordance: inline attribute text with no room
			// for a glyph. It toasts, and tints the row it copied.
			label: "CopyableValue (inline)",
			node: (
				<span className="font-mono text-[11px]">
					<CopyableValue value="7f3c9a21b4e8" label="span ID">
						7f3c9a21b4e8
					</CopyableValue>
				</span>
			),
		},
	]

	return (
		<>
			{rows.map((row) => (
				<div key={row.label} className="flex flex-col gap-1.5">
					<span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
						{row.label}
					</span>
					<div className="flex h-12 items-center rounded-md border bg-card px-3">{row.node}</div>
				</div>
			))}
		</>
	)
}

/**
 * These are the lab's sections, not the widget types: `sparkline` and `stress`
 * have no panel type of their own (one is a stat detail, the other is the chart
 * under pathological data), `chart` covers line/bar/area, and the labels match
 * the section headings below rather than the product's Type picker. Kept
 * hand-written for that reason — the renderers themselves come from the registry.
 */
const NAV_ITEMS: Array<{ id: string; label: string }> = [
	{ id: "copy", label: "Copy" },
	{ id: "stat", label: "Stat" },
	{ id: "gauge", label: "Gauge" },
	{ id: "sparkline", label: "Sparkline" },
	{ id: "chart", label: "Chart" },
	{ id: "stress", label: "Stress" },
	{ id: "table", label: "Table" },
	{ id: "list", label: "List" },
	{ id: "pie", label: "Pie" },
	{ id: "funnel", label: "Funnel" },
	{ id: "hbar", label: "Horizontal Bar" },
	{ id: "histogram", label: "Histogram" },
	{ id: "heatmap", label: "Heatmap" },
	{ id: "markdown", label: "Markdown" },
]

export function WidgetLab() {
	const [mode, setMode] = useState<WidgetMode>("view")

	return (
		<WidgetActionsScope actions={labActions}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Widget Lab" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Widget Lab"
								description="Every dashboard widget × every notable data scenario. Use this page to polish layout, typography, thresholds, and error states without touching live data."
							>
								<ToggleGroup
									value={[mode]}
									onValueChange={(values) => {
										const next = values[0]
										if (next === "view" || next === "edit") setMode(next)
									}}
									variant="outline"
									size="sm"
								>
									<ToggleGroupItem value="view">View</ToggleGroupItem>
									<ToggleGroupItem value="edit">Edit</ToggleGroupItem>
								</ToggleGroup>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="flex flex-col gap-8 pb-12">
								<nav className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-1 border-b bg-background/80 px-4 py-2 backdrop-blur">
									{NAV_ITEMS.map((item) => (
										<a
											key={item.id}
											href={`#${item.id}`}
											className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
										>
											{item.label}
										</a>
									))}
								</nav>

								<Section
									id="copy"
									title="Copy"
									description="The shared CopyButton. Polish: the check draws rather than pops, the label crossfade never changes the button width, and the error branch reads as a failure."
									minColWidth={240}
								>
									<CopyScenarios />
								</Section>

								<Section
									id="stat"
									title="Stat"
									description="Single aggregated value. Polish: threshold colors, prefix/suffix, long titles, edge values."
									minColWidth={240}
								>
									{statScenarios.map((s, i) => (
										<StatScenarioCard key={`stat-${i}`} scenario={s} mode={mode} />
									))}
									{statSparklineScenarios.map((s, i) => (
										<StatSparklineScenarioCard
											key={`stat-spark-${i}`}
											scenario={s}
											mode={mode}
										/>
									))}
								</Section>

								<Section
									id="gauge"
									title="Gauge"
									description="Single scalar on a radial arc. Polish: threshold arc coloring, tick marks, min/max range, edge values."
								>
									{gaugeScenarios.map((s, i) => (
										<GaugeScenarioCard key={`gauge-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="sparkline"
									title="Sparkline"
									description="The stat-widget trend line, rendered standalone across timeseries shapes. Polish: stroke, gradient, threshold color."
								>
									{sparklineSamples.map((sample, i) => (
										<ScenarioCell key={`spark-${i}`} label={sample.label}>
											<div className="flex h-full flex-col justify-end rounded-lg border bg-card p-3">
												<StatSparkline
													data={sample.data}
													color={sample.color}
													className="h-12 w-full"
												/>
											</div>
										</ScenarioCell>
									))}
								</Section>

								<Section
									id="chart"
									title="Chart"
									description="Every entry from the chart registry rendered with its bundled sample data, plus threshold overlays, the stats legend, and loading/error/empty states."
								>
									{chartScenarios.map((s, i) => (
										<ChartScenarioCard key={`chart-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="stress"
									title="Stress / edge cases"
									description="High-cardinality (10–50 series/slices), long series names, and null/zero data. Confirms distinct colors past series 5, scrollable legends that don't crush the plot, and pie/bar 'Other' bucketing."
								>
									{stressScenarios.map((s, i) => (
										<ChartScenarioCard key={`stress-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="table"
									title="Table"
									description="Tabular data with configurable columns, units, alignment, and cell thresholds."
								>
									{tableScenarios.map((s, i) => (
										<TableScenarioCard key={`table-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="list"
									title="List"
									description="Traces and logs lists with linked traceId/spanName columns."
								>
									{listScenarios.map((s, i) => (
										<ListScenarioCard key={`list-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="pie"
									title="Pie"
									description="Categorical breakdown. Polish: legend placement, label overflow, donut + percent."
								>
									{pieScenarios.map((s, i) => (
										<PieScenarioCard key={`pie-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="funnel"
									title="Funnel"
									description="Stage-by-stage drop-off as descending bars. Polish: % of first vs step conversion, long stage labels, single-stage and empty states."
								>
									{funnelScenarios.map((s, i) => (
										<FunnelScenarioCard key={`funnel-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="hbar"
									title="Horizontal Bar"
									description="Ranked categories, each a share of the total. Polish: long labels, value column alignment, overflow cap, near-identical top rows (the case a funnel mislabels as 100%)."
								>
									{hbarScenarios.map((s, i) => (
										<HbarScenarioCard key={`hbar-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="histogram"
									title="Histogram"
									description="Bucketed value distribution. Polish: log Y scale, narrow buckets, bell vs long-tail shapes."
								>
									{histogramScenarios.map((s, i) => (
										<HistogramScenarioCard key={`hist-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="heatmap"
									title="Heatmap"
									description="2D density. Polish: all OKLCH color scales, dense vs sparse data, linear vs log."
								>
									{heatmapScenarios.map((s, i) => (
										<HeatmapScenarioCard key={`heat-${i}`} scenario={s} mode={mode} />
									))}
								</Section>

								<Section
									id="markdown"
									title="Markdown"
									description="Static notes. Polish: heading/list rendering, inline code, sanitized links."
								>
									{markdownScenarios.map((s, i) => (
										<MarkdownScenarioCard key={`md-${i}`} scenario={s} mode={mode} />
									))}
								</Section>
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</WidgetActionsScope>
	)
}

// Per-widget scenario cards

function StatScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label} height={200}>
			<StatWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

/**
 * Any data source will do — the scope below answers for it instead of the
 * warehouse. It only has to be present, because `StatWidget` reaches the
 * sparkline branch on `display.sparkline.dataSource` being set.
 */
const LAB_SPARKLINE_SOURCE = makeQueryDataSource({ resultShape: "timeseries", queries: [] })

/**
 * The real `StatWidget`, with its sparkline series supplied instead of fetched.
 *
 * This used to be a hand-rebuilt copy of the widget's sparkline branch, which
 * meant the one renderer that fetches something was also the one renderer the
 * lab never actually verified.
 */
function StatSparklineScenarioCard({
	scenario,
	mode,
}: {
	scenario: StatSparklineScenario
	mode: WidgetMode
}) {
	const display = useMemo(
		() => ({
			...scenario.display,
			sparkline: { enabled: true, dataSource: LAB_SPARKLINE_SOURCE },
		}),
		[scenario.display],
	)
	// Stable per scenario: an unstable resolver remounts the sparkline every render.
	const resolve = useMemo(
		() => () => ({ status: "ready", data: scenario.sparklineData }) as const,
		[scenario.sparklineData],
	)

	return (
		<ScenarioCell label={scenario.label} height={220}>
			<SparklineSeriesScope resolve={resolve}>
				<StatWidget
					dataState={{ status: "ready", data: scenario.value }}
					display={display}
					mode={mode}
				/>
			</SparklineSeriesScope>
		</ScenarioCell>
	)
}

function GaugeScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<GaugeWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function ChartScenarioCard({ scenario, mode }: { scenario: ChartScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={`${scenario.label} (${scenario.category})`}>
			<ChartWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function TableScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<TableWidget
				dataState={scenario.dataState}
				display={scenario.display}
				mode={mode}
				rowLimit={scenario.rowLimit}
			/>
		</ScenarioCell>
	)
}

function ListScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<ListWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function PieScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<PieWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function FunnelScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<FunnelWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function HbarScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<HbarWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function HistogramScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<HistogramWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function HeatmapScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<HeatmapWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}

function MarkdownScenarioCard({ scenario, mode }: { scenario: WidgetScenario; mode: WidgetMode }) {
	return (
		<ScenarioCell label={scenario.label}>
			<MarkdownWidget dataState={scenario.dataState} display={scenario.display} mode={mode} />
		</ScenarioCell>
	)
}
