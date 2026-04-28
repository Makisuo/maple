import { Input } from "@maple/ui/components/ui/input"
import { getChartById, getChartsByCategory } from "@maple/ui/components/charts/registry"
import { ChartPreview } from "@/components/dashboard-builder/widgets/chart-preview"
import type {
	DashboardWidget,
	WidgetDisplayConfig,
	DataSourceEndpoint,
} from "@/components/dashboard-builder/types"

const ENDPOINT_OPTIONS: Array<{ value: DataSourceEndpoint; label: string }> = [
	{ value: "service_usage", label: "Service Usage" },
	{ value: "service_overview", label: "Service Overview" },
	{ value: "service_overview_time_series", label: "Service Time Series" },
	{ value: "errors_summary", label: "Errors Summary" },
	{ value: "errors_by_type", label: "Errors by Type" },
	{ value: "error_rate_by_service", label: "Error Rate by Service" },
	{ value: "list_traces", label: "Traces" },
	{ value: "list_logs", label: "Logs" },
	{ value: "list_metrics", label: "Metrics" },
	{ value: "metrics_summary", label: "Metrics Summary" },
	{ value: "custom_timeseries", label: "Custom Time Series" },
	{ value: "custom_breakdown", label: "Custom Breakdown" },
	{ value: "custom_query_builder_timeseries", label: "Query Builder (Multi Query)" },
]

interface WidgetEditPanelProps {
	widget: DashboardWidget
	onUpdateDisplay: (updates: Partial<WidgetDisplayConfig>) => void
}

export function WidgetEditPanel({ widget, onUpdateDisplay }: WidgetEditPanelProps) {
	const isChart = widget.visualization === "chart"
	const isMarkdown = widget.visualization === "markdown"
	const isPie = widget.visualization === "pie"
	const isHistogram = widget.visualization === "histogram"
	const isHeatmap = widget.visualization === "heatmap"
	const chartId = widget.display.chartId
	const currentChart = isChart && chartId ? getChartById(chartId) : null
	const variants = currentChart
		? getChartsByCategory(currentChart.category).filter((c) => c.tags.includes("query-builder"))
		: []

	const placeholder = currentChart?.name ?? widget.display.title ?? "Widget"

	return (
		<>
			<div className="flex flex-col gap-1.5">
				<label className="text-[10px] font-medium text-muted-foreground">Title</label>
				<Input
					placeholder={placeholder}
					value={widget.display.title || ""}
					onChange={(e) => onUpdateDisplay({ title: e.target.value })}
					className="h-7 text-xs"
				/>
			</div>

			{!isMarkdown && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Data Source</label>
					<div className="text-[10px] text-muted-foreground bg-muted px-2 py-1.5 rounded">
						{ENDPOINT_OPTIONS.find((o) => o.value === widget.dataSource.endpoint)?.label ??
							widget.dataSource.endpoint}
					</div>
				</div>
			)}

			{isMarkdown && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">
						Content (Markdown)
					</label>
					<textarea
						value={widget.display.markdown?.content ?? ""}
						onChange={(e) =>
							onUpdateDisplay({
								markdown: { content: e.target.value },
							})
						}
						placeholder="# Heading\n\nText with **bold**, *italic*, [links](https://example.com), and `code`."
						className="text-xs font-mono bg-background border border-border rounded px-2 py-1.5 min-h-[160px] resize-y outline-none focus:ring-1 focus:ring-foreground/20"
					/>
				</div>
			)}

			{isPie && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Pie style</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.pie?.donut ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									pie: { ...widget.display.pie, donut: e.target.checked },
								})
							}
						/>
						Donut mode
					</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.pie?.showLabels ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									pie: { ...widget.display.pie, showLabels: e.target.checked },
								})
							}
						/>
						Show slice labels
					</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.pie?.showPercent ?? true}
							onChange={(e) =>
								onUpdateDisplay({
									pie: { ...widget.display.pie, showPercent: e.target.checked },
								})
							}
						/>
						Show percentages
					</label>
				</div>
			)}

			{isHistogram && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Buckets</label>
					<Input
						type="number"
						min={2}
						max={200}
						value={widget.display.histogram?.bucketCount ?? 30}
						onChange={(e) =>
							onUpdateDisplay({
								histogram: {
									...widget.display.histogram,
									bucketCount: Number(e.target.value) || 30,
								},
							})
						}
						className="h-7 text-xs"
					/>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.histogram?.logScaleY ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									histogram: {
										...widget.display.histogram,
										logScaleY: e.target.checked,
									},
								})
							}
						/>
						Log-scale Y axis
					</label>
				</div>
			)}

			{isHeatmap && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Color scale</label>
					<select
						value={widget.display.heatmap?.colorScale ?? "blues"}
						onChange={(e) =>
							onUpdateDisplay({
								heatmap: {
									...widget.display.heatmap,
									colorScale: e.target.value as
										| "viridis"
										| "magma"
										| "cividis"
										| "blues"
										| "reds",
								},
							})
						}
						className="h-7 text-xs bg-background border border-border rounded px-2"
					>
						<option value="blues">Blues</option>
						<option value="reds">Reds</option>
						<option value="viridis">Viridis</option>
						<option value="magma">Magma</option>
						<option value="cividis">Cividis</option>
					</select>
				</div>
			)}

			{isChart && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Y axis</label>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.yAxis?.logScale ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									yAxis: { ...widget.display.yAxis, logScale: e.target.checked },
								})
							}
						/>
						Log scale
					</label>
					<div className="grid grid-cols-2 gap-1.5">
						<Input
							type="number"
							placeholder="Soft min"
							value={widget.display.yAxis?.softMin ?? ""}
							onChange={(e) =>
								onUpdateDisplay({
									yAxis: {
										...widget.display.yAxis,
										softMin: e.target.value === "" ? undefined : Number(e.target.value),
									},
								})
							}
							className="h-7 text-xs"
						/>
						<Input
							type="number"
							placeholder="Soft max"
							value={widget.display.yAxis?.softMax ?? ""}
							onChange={(e) =>
								onUpdateDisplay({
									yAxis: {
										...widget.display.yAxis,
										softMax: e.target.value === "" ? undefined : Number(e.target.value),
									},
								})
							}
							className="h-7 text-xs"
						/>
					</div>
					<label className="flex items-center gap-2 text-[10px]">
						<input
							type="checkbox"
							checked={widget.display.chartPresentation?.showPoints ?? false}
							onChange={(e) =>
								onUpdateDisplay({
									chartPresentation: {
										...widget.display.chartPresentation,
										showPoints: e.target.checked,
									},
								})
							}
						/>
						Show points (line charts)
					</label>
				</div>
			)}

			{isChart && variants.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<label className="text-[10px] font-medium text-muted-foreground">Variant</label>
					<div className="grid grid-cols-3 gap-1.5">
						{variants.map((variant) => {
							const isActive = variant.id === chartId

							return (
								<button
									key={variant.id}
									type="button"
									onClick={() => onUpdateDisplay({ chartId: variant.id })}
									className={`ring-1 p-1.5 transition-all ${
										isActive
											? "ring-foreground ring-2"
											: "ring-border hover:ring-foreground/30"
									}`}
								>
									<ChartPreview component={variant.component} />
									<div className="text-[9px] text-muted-foreground truncate mt-1">
										{variant.name}
									</div>
								</button>
							)
						})}
					</div>
				</div>
			)}
		</>
	)
}
