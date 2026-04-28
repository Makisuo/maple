import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { Atom, useAtom } from "@/lib/effect-atom"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardCanvas } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { DashboardToolbar } from "@/components/dashboard-builder/toolbar/dashboard-toolbar"
import { WidgetPicker } from "@/components/dashboard-builder/config/chart-picker"
import { InlineEditableTitle } from "@/components/dashboard-builder/inline-editable-title"
import {
	DashboardTimeRangeWrapper,
	useDashboardTimeRange,
} from "@/components/dashboard-builder/dashboard-providers"
import {
	DashboardActionsProvider,
	useDashboardActions,
} from "@/components/dashboard-builder/dashboard-actions-context"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { WidgetMode } from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { DashboardAiPanel } from "@/components/dashboard-builder/ai"
import { DashboardHistoryPanel, PreviewedCanvas } from "@/components/dashboard-builder/history"
import { historyPanelOpenAtom, previewedVersionAtom } from "@/atoms/dashboard-history-atoms"
import { useDashboardVersions } from "@/components/dashboard-builder/history/use-dashboard-history"
import { Result } from "@/lib/effect-atom"
import type { ReactNode } from "react"

// Module-level atoms — singleton (only one dashboard page visible at a time)
const chartPickerOpenAtom = Atom.make(false)
const aiPanelOpenAtom = Atom.make(false)

const dashboardViewSearchSchema = Schema.Struct({
	mode: Schema.optional(Schema.Literal("edit")),
})

export const Route = effectRoute(createFileRoute("/dashboards/$dashboardId"))({
	component: DashboardViewPage,
	validateSearch: Schema.toStandardSchemaV1(dashboardViewSearchSchema),
})

function DashboardRefreshBridge({ children }: { children: ReactNode }) {
	const {
		state: { timeRange },
	} = useDashboardTimeRange()
	const timePreset = timeRange.type === "relative" ? timeRange.value : undefined
	return <PageRefreshProvider timePreset={timePreset}>{children}</PageRefreshProvider>
}

function DashboardViewPage() {
	const { dashboardId } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate()

	const {
		dashboards,
		readOnly,
		persistenceError,
		updateDashboard,
		updateDashboardTimeRange,
		addWidget,
		cloneWidget,
		removeWidget,
		updateWidgetDisplay,
		updateWidgetLayouts,
		autoLayoutWidgets,
	} = useDashboardStore()

	const [chartPickerOpen, setChartPickerOpen] = useAtom(chartPickerOpenAtom)
	const [aiPanelOpen, setAiPanelOpen] = useAtom(aiPanelOpenAtom)
	const [historyPanelOpen, setHistoryPanelOpen] = useAtom(historyPanelOpenAtom)
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)

	const activeDashboard = dashboards.find((d) => d.id === dashboardId)

	const isPreviewing = previewed !== null
	const mode: WidgetMode = search.mode === "edit" && !readOnly && !isPreviewing ? "edit" : "view"

	const handleToggleEdit = () => {
		if (isPreviewing) return
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			search: mode === "edit" ? {} : { mode: "edit" },
		})
	}

	const openHistory = () => {
		setAiPanelOpen(false)
		setHistoryPanelOpen(true)
	}

	const openAi = () => {
		setHistoryPanelOpen(false)
		setPreviewed(null)
		setAiPanelOpen(true)
	}

	if (!activeDashboard) {
		return (
			<DashboardLayout breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: "..." }]}>
				<div className="py-12 text-sm text-muted-foreground">Loading dashboard...</div>
			</DashboardLayout>
		)
	}

	return (
		<DashboardTimeRangeWrapper
			key={dashboardId}
			initialTimeRange={activeDashboard.timeRange}
			onTimeRangeChange={(timeRange) => updateDashboardTimeRange(activeDashboard.id, timeRange)}
		>
			<DashboardActionsProvider
				dashboardId={dashboardId}
				mode={mode}
				readOnly={readOnly || isPreviewing}
				store={{
					addWidget,
					removeWidget,
					cloneWidget,
					updateWidgetDisplay,
					updateWidgetLayouts,
					autoLayoutWidgets,
				}}
			>
				<DashboardRefreshBridge>
					<DashboardLayout
						breadcrumbs={[
							{ label: "Dashboards", href: "/dashboards" },
							{ label: activeDashboard.name },
						]}
						titleContent={
							<InlineEditableTitle
								value={activeDashboard.name}
								readOnly={readOnly || isPreviewing}
								onChange={(name) => updateDashboard(dashboardId, { name })}
							/>
						}
						headerActions={
							<DashboardToolbar
								dashboard={activeDashboard}
								onToggleEdit={handleToggleEdit}
								onAddWidget={() => setChartPickerOpen(true)}
								onOpenAi={openAi}
								onOpenHistory={openHistory}
							/>
						}
						rightSidebar={
							historyPanelOpen ? (
								<HistoryPanelMount
									dashboardId={dashboardId}
									onClose={() => {
										setHistoryPanelOpen(false)
										setPreviewed(null)
									}}
								/>
							) : aiPanelOpen ? (
								<DashboardAiPanel
									onOpenChange={setAiPanelOpen}
									dashboardName={activeDashboard.name}
									widgets={activeDashboard.widgets}
								/>
							) : undefined
						}
					>
						{persistenceError && (
							<div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
								{persistenceError}. Dashboard editing is temporarily disabled.
							</div>
						)}

						{isPreviewing && previewed ? (
							<PreviewedCanvas
								dashboardId={dashboardId}
								preview={previewed}
								onCancel={() => setPreviewed(null)}
								onRestored={() => setPreviewed(null)}
							/>
						) : activeDashboard.widgets.length === 0 && mode === "view" ? (
							<div className="flex flex-col items-center justify-center py-24 gap-4">
								<div className="flex gap-2">
									<div className="w-8 h-8 rounded bg-primary/15" />
									<div className="w-8 h-8 rounded bg-primary/10" />
									<div className="w-8 h-8 rounded bg-primary/15" />
								</div>
								<div className="flex flex-col items-center gap-1">
									<p className="text-sm font-medium text-foreground">No widgets yet</p>
									<p className="text-xs text-muted-foreground">
										Add charts, stats, and tables to build your dashboard.
									</p>
								</div>
								<button
									type="button"
									disabled={readOnly}
									className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
									onClick={() => {
										navigate({
											to: "/dashboards/$dashboardId",
											params: { dashboardId },
											search: { mode: "edit" },
										})
										setChartPickerOpen(true)
									}}
								>
									Add your first widget
								</button>
							</div>
						) : (
							<DashboardCanvas widgets={activeDashboard.widgets} />
						)}

						<WidgetPickerWithActions
							open={readOnly || isPreviewing ? false : chartPickerOpen}
							onOpenChange={readOnly || isPreviewing ? () => undefined : setChartPickerOpen}
						/>
					</DashboardLayout>
				</DashboardRefreshBridge>
			</DashboardActionsProvider>
		</DashboardTimeRangeWrapper>
	)
}

function HistoryPanelMount({ dashboardId, onClose }: { dashboardId: string; onClose: () => void }) {
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)
	const result = useDashboardVersions(dashboardId)

	const onPreview = (versionId: string) => {
		if (!Result.isSuccess(result)) return
		const version = result.value.versions.find((v) => v.id === versionId)
		if (!version) return
		setPreviewed({
			versionId: version.id,
			versionNumber: version.versionNumber,
			createdAt: version.createdAt,
			createdBy: version.createdBy,
		})
	}

	return (
		<DashboardHistoryPanel
			dashboardId={dashboardId}
			previewed={previewed}
			onPreview={onPreview}
			onClose={onClose}
		/>
	)
}

function WidgetPickerWithActions({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const { addWidget } = useDashboardActions()
	return <WidgetPicker open={open} onOpenChange={onOpenChange} onSelect={addWidget} />
}
