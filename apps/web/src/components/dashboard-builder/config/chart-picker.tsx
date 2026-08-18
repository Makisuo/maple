// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { useState } from "react"

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
import type { WidgetPresetDefinition } from "@/components/dashboard-builder/widgets/widget-definitions"
import { widgetTypeList } from "@/components/dashboard-builder/widgets/types"
import { createQueryDraft } from "@maple/query-engine/query-builder"
import { makeQueryDataSource } from "@maple/widgets/dashboard"
import { deriveDefaultWidgetTitle } from "@/lib/query-builder/widget-builder-utils"

// "Add widget".
//
// Every section but the first is a widget type's `presets` rendered with its
// `PresetPreview`, so the picker gains a tab the moment a type declares presets.
// This used to be nine hand-written sections behind nine parallel `showX`
// booleans, with the sample data for four of them inlined here.
//
// Charts are the exception: line/bar/area have no presets because they are the
// blank starting point, so their section offers the three chart styles directly.

const CHART_STYLES = [
	{
		chartId: "query-builder-bar",
		previewChartId: "default-bar",
		label: "Bar Chart",
		description: "Compare values across categories",
	},
	{
		chartId: "query-builder-area",
		previewChartId: "gradient-area",
		label: "Area Chart",
		description: "Visualize trends over time",
	},
	{
		chartId: "query-builder-line",
		previewChartId: "dotted-line",
		label: "Line Chart",
		description: "Track metrics over time",
	},
]

/** Sections after "Charts": one per widget type that ships presets. */
const PRESET_SECTIONS = widgetTypeList
	.filter((definition) => definition.presets.length > 0 && definition.PresetPreview)
	.map((definition) => ({
		id: definition.meta.panelType,
		// "Pie" → "Pies", "Note" → "Notes".
		label: `${definition.meta.label}s`,
		presets: definition.presets,
		Preview: definition.PresetPreview!,
	}))

const TABS = [
	{ id: "all", label: "All" },
	{ id: "charts", label: "Charts" },
	...PRESET_SECTIONS.map((section) => ({ id: section.id, label: section.label })),
]

function PickerCard({
	title,
	description,
	onClick,
	children,
}: {
	title: string
	description?: string
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="group ring-1 ring-border hover:ring-border-active bg-background p-4 text-left transition-all flex flex-col gap-3 rounded-md"
		>
			{children}
			<div className="flex flex-col gap-0.5">
				<div className="text-xs font-medium">{title}</div>
				{description && <div className="text-[11px] text-dim">{description}</div>}
			</div>
		</button>
	)
}

function PickerSection({
	title,
	showHeading,
	children,
}: {
	title: string
	showHeading: boolean
	children: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-3">
			{showHeading && (
				<h3 className="text-[10px] font-semibold text-dim uppercase tracking-wider">{title}</h3>
			)}
			<div className="grid grid-cols-3 gap-3">{children}</div>
		</div>
	)
}

interface WidgetPickerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/**
	 * Returns the widget that was added, or a falsy value when the add was
	 * refused. The dialog stays open in that case — dismissing itself with
	 * nothing added is indistinguishable from a dead click.
	 */
	onSelect: (
		visualization: VisualizationType,
		dataSource: WidgetDataSource,
		display: WidgetDisplayConfig,
	) => unknown
}

export function WidgetPicker({ open, onOpenChange, onSelect }: WidgetPickerProps) {
	const [activeTab, setActiveTab] = useState<string>("all")
	const isVisible = (id: string) => activeTab === "all" || activeTab === id
	const showHeading = activeTab === "all"

	const handleSelectChart = (chartId: string) => {
		const draft = createQueryDraft(0)
		const added = onSelect(
			"chart",
			makeQueryDataSource({
				resultShape: "timeseries",
				queries: [draft],
				formulas: [],
				comparison: { mode: "none", includePercentChange: true },
			}),
			// Derived title ("Error rate by service.name") so freshly added
			// charts never render as "Untitled".
			{ chartId, title: deriveDefaultWidgetTitle([draft]) },
		)
		if (added) onOpenChange(false)
	}

	const handleSelectPreset = (preset: WidgetPresetDefinition) => {
		const added = onSelect(preset.visualization, preset.dataSource, preset.display)
		if (added) onOpenChange(false)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Add Widget</DialogTitle>
					<DialogDescription>
						Choose a visualization type to add to your dashboard.
					</DialogDescription>
				</DialogHeader>

				<div className="flex gap-0 border-b border-border">
					{TABS.map((tab) => (
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

				<div className="flex flex-col gap-5 max-h-[60vh] overflow-y-auto py-5 px-4">
					{isVisible("charts") && (
						<PickerSection title="Charts" showHeading={showHeading}>
							{CHART_STYLES.map((style) => {
								const entry = getChartById(style.previewChartId)
								if (!entry) return null
								return (
									<PickerCard
										key={style.chartId}
										title={style.label}
										description={style.description}
										onClick={() => handleSelectChart(style.chartId)}
									>
										<ChartPreview component={entry.component} data={entry.sampleData} />
									</PickerCard>
								)
							})}
						</PickerSection>
					)}

					{PRESET_SECTIONS.filter((section) => isVisible(section.id)).map((section) => (
						<PickerSection key={section.id} title={section.label} showHeading={showHeading}>
							{section.presets.map((preset) => (
								<PickerCard
									key={preset.id}
									title={preset.name}
									description={preset.description}
									onClick={() => handleSelectPreset(preset)}
								>
									<section.Preview preset={preset} />
								</PickerCard>
							))}
						</PickerSection>
					))}
				</div>
			</DialogContent>
		</Dialog>
	)
}
