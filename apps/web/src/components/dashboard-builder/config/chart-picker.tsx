import { useMemo } from "react"
import { Atom, useAtom } from "@/lib/effect-atom"

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@maple/ui/components/ui/dialog"
import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartPreview } from "@/components/dashboard-builder/widgets/chart-preview"
import type {
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import {
	statPresets,
	tablePresets,
	listPresets,
	piePresets,
	histogramPresets,
	heatmapPresets,
	markdownPresets,
	type WidgetPresetDefinition,
} from "@/components/dashboard-builder/widgets/widget-definitions"
import { formatValue } from "@/components/dashboard-builder/widgets/stat-widget"
import { formatCellValue } from "@/components/dashboard-builder/widgets/table-widget"
import { createQueryDraft } from "@/lib/query-builder/model"

type ChartCategory = "bar" | "area" | "line"

const categoryDefaults: Array<{
	category: ChartCategory
	chartId: string
	previewChartId: string
	label: string
}> = [
	{ category: "bar", chartId: "query-builder-bar", previewChartId: "default-bar", label: "Bar Chart" },
	{ category: "area", chartId: "query-builder-area", previewChartId: "gradient-area", label: "Area Chart" },
	{ category: "line", chartId: "query-builder-line", previewChartId: "dotted-line", label: "Line Chart" },
]

type PickerTab =
	| "all"
	| "charts"
	| "stats"
	| "tables"
	| "lists"
	| "pies"
	| "histograms"
	| "heatmaps"
	| "raw-sql"
	| "notes"

const tabs: { id: PickerTab; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "charts", label: "Charts" },
	{ id: "pies", label: "Pies" },
	{ id: "histograms", label: "Histograms" },
	{ id: "heatmaps", label: "Heatmaps" },
	{ id: "stats", label: "Stats" },
	{ id: "tables", label: "Tables" },
	{ id: "lists", label: "Lists" },
	{ id: "raw-sql", label: "Raw SQL" },
	{ id: "notes", label: "Notes" },
]

const RAW_SQL_TIMESERIES_TEMPLATE = `SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
       count() AS logs
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket`

const RAW_SQL_TABLE_TEMPLATE = `SELECT ServiceName, count() AS spans
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY ServiceName
ORDER BY spans DESC
LIMIT 20`

const RAW_SQL_STAT_TEMPLATE = `SELECT count() AS value
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)`

const RAW_SQL_PIE_TEMPLATE = `SELECT ServiceName AS name, count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY name
ORDER BY value DESC
LIMIT 8`

const RAW_SQL_HISTOGRAM_TEMPLATE = `SELECT Duration / 1000000 AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
LIMIT 5000`

const RAW_SQL_HEATMAP_TEMPLATE = `SELECT ServiceName AS x,
       toString(toHour(Timestamp)) AS y,
       count() AS value
FROM service_overview_spans
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY x, y
ORDER BY x, y`

type RawSqlDisplayType = "line" | "area" | "bar" | "table" | "stat" | "pie" | "histogram" | "heatmap"

const rawSqlPresets: Array<{
	id: string
	label: string
	description: string
	visualization: VisualizationType
	displayType: RawSqlDisplayType
	chartId?: string
	sql: string
	display?: Partial<WidgetDisplayConfig>
	transform?: NonNullable<import("@/components/dashboard-builder/types").WidgetDataSource["transform"]>
}> = [
	{
		id: "raw-sql-line",
		label: "Raw SQL — Line",
		description: "Time-series line chart from custom SQL.",
		visualization: "chart",
		displayType: "line",
		chartId: "query-builder-line",
		sql: RAW_SQL_TIMESERIES_TEMPLATE,
	},
	{
		id: "raw-sql-area",
		label: "Raw SQL — Area",
		description: "Time-series area chart from custom SQL.",
		visualization: "chart",
		displayType: "area",
		chartId: "query-builder-area",
		sql: RAW_SQL_TIMESERIES_TEMPLATE,
	},
	{
		id: "raw-sql-bar",
		label: "Raw SQL — Bar",
		description: "Time-bucketed bar chart from custom SQL.",
		visualization: "chart",
		displayType: "bar",
		chartId: "query-builder-bar",
		sql: RAW_SQL_TIMESERIES_TEMPLATE,
	},
	{
		id: "raw-sql-table",
		label: "Raw SQL — Table",
		description: "Tabular result from a custom ClickHouse query.",
		visualization: "table",
		displayType: "table",
		sql: RAW_SQL_TABLE_TEMPLATE,
	},
	{
		id: "raw-sql-stat",
		label: "Raw SQL — Stat",
		description: "Single number from a scalar query.",
		visualization: "stat",
		displayType: "stat",
		sql: RAW_SQL_STAT_TEMPLATE,
		display: { unit: "number" },
		transform: { reduceToValue: { field: "value", aggregate: "first" } },
	},
	{
		id: "raw-sql-pie",
		label: "Raw SQL — Pie",
		description: "Composition pie chart (name + value rows).",
		visualization: "pie",
		displayType: "pie",
		chartId: "query-builder-pie",
		sql: RAW_SQL_PIE_TEMPLATE,
	},
	{
		id: "raw-sql-histogram",
		label: "Raw SQL — Histogram",
		description: "Distribution histogram from per-row values.",
		visualization: "histogram",
		displayType: "histogram",
		chartId: "query-builder-histogram",
		sql: RAW_SQL_HISTOGRAM_TEMPLATE,
	},
	{
		id: "raw-sql-heatmap",
		label: "Raw SQL — Heatmap",
		description: "2D bucket grid from x / y / value rows.",
		visualization: "heatmap",
		displayType: "heatmap",
		chartId: "query-builder-heatmap",
		sql: RAW_SQL_HEATMAP_TEMPLATE,
	},
]

const chartDescriptions: Record<string, string> = {
	"query-builder-bar": "Compare values across categories",
	"query-builder-area": "Visualize trends over time",
	"query-builder-line": "Track metrics over time",
}

// Sample values for stat previews
const statSampleValues: Record<string, number> = {
	"stat-total-traces": 48293,
	"stat-total-logs": 124817,
	"stat-error-rate": 0.032,
	"stat-total-errors": 1247,
	"stat-total-services": 12,
}

// Sample rows for list previews
const listSampleRows: Record<string, Record<string, unknown>[]> = {
	"list-traces": [
		{ serviceName: "api-gw", spanName: "GET /api/users", durationMs: 142, statusCode: "Ok" },
		{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, statusCode: "Error" },
		{ serviceName: "api-gw", spanName: "GET /api/health", durationMs: 3, statusCode: "Ok" },
	],
	"list-error-traces": [
		{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, statusCode: "Error" },
		{ serviceName: "auth-svc", spanName: "GET /api/auth", durationMs: 2301, statusCode: "Error" },
		{ serviceName: "item-svc", spanName: "PUT /api/items", durationMs: 445, statusCode: "Error" },
	],
	"list-logs": [
		{ timestamp: "12:04:23", severityText: "ERROR", serviceName: "api-gw", body: "Connection refused" },
		{ timestamp: "12:04:21", severityText: "WARN", serviceName: "user-svc", body: "Slow query" },
		{ timestamp: "12:04:19", severityText: "INFO", serviceName: "api-gw", body: "Request handled" },
	],
}

// Sample rows for table previews
const tableSampleRows: Record<string, Record<string, unknown>[]> = {
	"table-traces": [
		{ serviceName: "api-gw", spanName: "GET /api/users", durationMs: 142, hasError: false },
		{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, hasError: true },
		{ serviceName: "api-gw", spanName: "GET /api/health", durationMs: 3, hasError: false },
	],
	"table-errors": [
		{ errorType: "ConnectionTimeout", count: 342, affectedServicesCount: 5 },
		{ errorType: "NullPointerException", count: 128, affectedServicesCount: 3 },
		{ errorType: "RateLimitExceeded", count: 87, affectedServicesCount: 2 },
	],
	"table-services": [
		{ serviceName: "api-gateway", p95LatencyMs: 245, errorRate: 2.1, throughput: 1250 },
		{ serviceName: "user-service", p95LatencyMs: 89, errorRate: 0.4, throughput: 830 },
		{ serviceName: "order-service", p95LatencyMs: 412, errorRate: 5.2, throughput: 340 },
	],
}

function StatPreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const sampleValue = statSampleValues[preset.id] ?? 0
	const formatted = formatValue(
		sampleValue,
		preset.display.unit,
		preset.display.prefix,
		preset.display.suffix,
	)

	return (
		<div className="aspect-[4/3] flex flex-col items-center justify-center gap-1.5">
			<div className="text-[10px] text-muted-foreground">{preset.display.title}</div>
			<div className="text-lg font-bold">{formatted}</div>
		</div>
	)
}

function TablePreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const rows = tableSampleRows[preset.id] ?? []
	const columns = preset.display.columns ?? []

	return (
		<div className="aspect-[4/3] flex flex-col overflow-hidden">
			<div className="text-[10px] text-muted-foreground mb-1 px-0.5">{preset.display.title}</div>
			<table className="w-full text-[9px]">
				<thead>
					<tr className="border-b border-border">
						{columns.map((col) => (
							<th
								key={col.field}
								className="px-1 py-0.5 font-medium text-muted-foreground"
								style={{ textAlign: col.align ?? "left" }}
							>
								{col.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						<tr key={i} className="border-b border-border/50">
							{columns.map((col) => (
								<td
									key={col.field}
									className="px-1 py-0.5 truncate max-w-[80px]"
									style={{ textAlign: col.align ?? "left" }}
								>
									{formatCellValue(row[col.field], col.unit)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function PiePreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const entry = getChartById(preset.display.chartId ?? "query-builder-pie")
	if (!entry) return <div className="aspect-[4/3]" />
	const Component = entry.component
	return (
		<div className="aspect-[4/3] flex flex-col gap-1.5">
			<div className="text-[10px] text-muted-foreground">{preset.display.title}</div>
			<ChartPreview component={Component} />
		</div>
	)
}

function HistogramPreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const entry = getChartById(preset.display.chartId ?? "query-builder-histogram")
	if (!entry) return <div className="aspect-[4/3]" />
	const Component = entry.component
	return (
		<div className="aspect-[4/3] flex flex-col gap-1.5">
			<div className="text-[10px] text-muted-foreground">{preset.display.title}</div>
			<ChartPreview component={Component} />
		</div>
	)
}

function HeatmapPreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const entry = getChartById(preset.display.chartId ?? "query-builder-heatmap")
	if (!entry) return <div className="aspect-[4/3]" />
	const Component = entry.component
	return (
		<div className="aspect-[4/3] flex flex-col gap-1.5">
			<div className="text-[10px] text-muted-foreground">{preset.display.title}</div>
			<ChartPreview component={Component} />
		</div>
	)
}

function MarkdownPreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const content = preset.display.markdown?.content ?? ""
	const lines = content
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.slice(0, 4)
	return (
		<div className="aspect-[4/3] flex flex-col gap-1 overflow-hidden p-1">
			<div className="text-[10px] text-muted-foreground">{preset.display.title}</div>
			{lines.map((line, i) => (
				<div
					key={i}
					className={`text-[9px] ${
						line.startsWith("#") ? "font-semibold" : "text-muted-foreground"
					} truncate`}
				>
					{line.replace(/^#+\s*/, "").replace(/[*`]/g, "")}
				</div>
			))}
		</div>
	)
}

function ListPreviewCard({ preset }: { preset: WidgetPresetDefinition }) {
	const rows = listSampleRows[preset.id] ?? []
	const columns = preset.display.columns ?? []

	return (
		<div className="aspect-[4/3] flex flex-col overflow-hidden">
			<div className="text-[10px] text-muted-foreground mb-1 px-0.5">{preset.display.title}</div>
			<table className="w-full text-[9px]">
				<thead>
					<tr className="border-b border-border">
						{columns.map((col) => (
							<th
								key={col.field}
								className="px-1 py-0.5 font-medium text-muted-foreground"
								style={{ textAlign: col.align ?? "left" }}
							>
								{col.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						<tr key={i} className="border-b border-border/50">
							{columns.map((col) => (
								<td
									key={col.field}
									className="px-1 py-0.5 truncate max-w-[80px]"
									style={{ textAlign: col.align ?? "left" }}
								>
									{formatCellValue(row[col.field], col.unit)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

interface WidgetPickerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onSelect: (
		visualization: VisualizationType,
		dataSource: WidgetDataSource,
		display: WidgetDisplayConfig,
	) => void
}

export function WidgetPicker({ open, onOpenChange, onSelect }: WidgetPickerProps) {
	const activeTabAtom = useMemo(() => Atom.make<PickerTab>("all"), [])
	const [activeTab, setActiveTab] = useAtom(activeTabAtom)

	const handleSelectChart = (chartId: string) => {
		onSelect(
			"chart",
			{
				endpoint: "custom_query_builder_timeseries",
				params: {
					queries: [createQueryDraft(0)],
					formulas: [],
					comparison: {
						mode: "none",
						includePercentChange: true,
					},
					debug: false,
				},
			},
			{ chartId },
		)
		onOpenChange(false)
	}

	const handleSelectPreset = (preset: WidgetPresetDefinition) => {
		onSelect(preset.visualization, preset.dataSource, preset.display)
		onOpenChange(false)
	}

	const handleSelectRawSql = (preset: (typeof rawSqlPresets)[number]) => {
		onSelect(
			preset.visualization,
			{
				endpoint: "raw_sql_chart",
				params: {
					sql: preset.sql,
					displayType: preset.displayType,
				},
				...(preset.transform ? { transform: preset.transform } : {}),
			},
			{
				title: preset.label,
				...(preset.chartId ? { chartId: preset.chartId } : {}),
				...(preset.display ?? {}),
			},
		)
		onOpenChange(false)
	}

	const showCharts = activeTab === "all" || activeTab === "charts"
	const showStats = activeTab === "all" || activeTab === "stats"
	const showTables = activeTab === "all" || activeTab === "tables"
	const showLists = activeTab === "all" || activeTab === "lists"
	const showPies = activeTab === "all" || activeTab === "pies"
	const showHistograms = activeTab === "all" || activeTab === "histograms"
	const showHeatmaps = activeTab === "all" || activeTab === "heatmaps"
	const showRawSql = activeTab === "all" || activeTab === "raw-sql"
	const showNotes = activeTab === "all" || activeTab === "notes"

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Add Widget</DialogTitle>
					<DialogDescription>
						Choose a visualization type to add to your dashboard.
					</DialogDescription>
				</DialogHeader>

				<div className="flex gap-0 border-b border-border -mx-6 px-6">
					{tabs.map((tab) => (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							className={`px-4 py-2.5 text-xs font-medium transition-all ${
								activeTab === tab.id
									? "text-foreground border-b-2 border-primary"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{tab.label}
						</button>
					))}
				</div>

				<div className="flex flex-col gap-5 max-h-[60vh] overflow-y-auto py-1">
					{showCharts && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Charts
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{categoryDefaults.map(({ chartId, previewChartId, label }) => {
									const entry = getChartById(previewChartId)
									if (!entry) return null
									const Component = entry.component

									return (
										<button
											key={chartId}
											type="button"
											onClick={() => handleSelectChart(chartId)}
											className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
										>
											<ChartPreview component={Component} />
											<div className="flex flex-col gap-0.5">
												<div className="text-xs font-medium">{label}</div>
												<div className="text-[11px] text-dim">
													{chartDescriptions[chartId] ?? ""}
												</div>
											</div>
										</button>
									)
								})}
							</div>
						</div>
					)}

					{showPies && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Pies
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{piePresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<PiePreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showHistograms && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Histograms
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{histogramPresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<HistogramPreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showHeatmaps && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Heatmaps
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{heatmapPresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<HeatmapPreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showRawSql && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Raw SQL
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{rawSqlPresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectRawSql(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<div className="aspect-[4/3] flex flex-col gap-1 overflow-hidden p-1 bg-muted/30 rounded">
											<div className="text-[9px] text-muted-foreground font-mono leading-tight">
												{preset.sql.split("\n").slice(0, 6).join("\n")}
											</div>
										</div>
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.label}</div>
											<div className="text-[11px] text-dim">{preset.description}</div>
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showNotes && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Notes
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{markdownPresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<MarkdownPreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showStats && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Stats
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{statPresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<StatPreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showTables && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Tables
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{tablePresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<TablePreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}

					{showLists && (
						<div className="flex flex-col gap-3">
							{activeTab === "all" && (
								<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">
									Lists
								</h3>
							)}
							<div className="grid grid-cols-3 gap-3">
								{listPresets.map((preset) => (
									<button
										key={preset.id}
										type="button"
										onClick={() => handleSelectPreset(preset)}
										className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
									>
										<ListPreviewCard preset={preset} />
										<div className="flex flex-col gap-0.5">
											<div className="text-xs font-medium">{preset.name}</div>
											{preset.description && (
												<div className="text-[11px] text-dim">
													{preset.description}
												</div>
											)}
										</div>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}
