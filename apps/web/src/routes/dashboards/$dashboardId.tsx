import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { DashboardId, DashboardVersionId } from "@maple/domain/http"
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
import { DashboardVariablesProvider } from "@/components/dashboard-builder/dashboard-variables-context"
import {
	VARIABLE_PARAM_PREFIX,
	pickVariableParams,
	variableSearchRest,
} from "@/lib/dashboard-variables/search-params"
import {
	DashboardActionsProvider,
	useDashboardActions,
} from "@/components/dashboard-builder/dashboard-actions-context"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { WidgetMode } from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { DashboardHistoryPanel, PreviewedCanvas } from "@/components/dashboard-builder/history"
import { historyPanelOpenAtom, previewedVersionAtom } from "@/atoms/dashboard-history-atoms"
import { useDashboardVersions } from "@/components/dashboard-builder/history/use-dashboard-history"
import { Result } from "@/lib/effect-atom"
import { useMemo, type ReactNode } from "react"

// Module-level atoms — singleton (only one dashboard page visible at a time)
const chartPickerOpenAtom = Atom.make(false)

// Decode the raw `$dashboardId` URL segment into its branded id once, at the
// route boundary, so the branded value threads through the store/history hooks
// without a per-call cast.
const asDashboardId = Schema.decodeSync(DashboardId)

// `var-<name>` keys carry dashboard-variable selections (Grafana-style), so
// views are shareable/deep-linkable. Values are `Unknown` on purpose: TanStack
// JSON-parses each search value, and a hand-edited URL must never crash the
// route — non-string values are coerced or ignored when read.
const dashboardViewSearchSchema = Schema.StructWithRest(
	Schema.Struct({
		mode: Schema.optional(Schema.Literal("edit")),
	}),
	[variableSearchRest],
)

function variableValuesFromSearch(search: Record<string, unknown>): Record<string, string> {
	const values: Record<string, string> = {}
	for (const [key, value] of Object.entries(search)) {
		if (!key.startsWith(VARIABLE_PARAM_PREFIX)) continue
		if (typeof value === "string") {
			values[key.slice(VARIABLE_PARAM_PREFIX.length)] = value
		} else if (typeof value === "number" || typeof value === "boolean") {
			values[key.slice(VARIABLE_PARAM_PREFIX.length)] = String(value)
		}
	}
	return values
}

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
	const { dashboardId: dashboardIdParam } = Route.useParams()
	const dashboardId = asDashboardId(dashboardIdParam)
	const search = Route.useSearch()
	const navigate = useNavigate()

	const {
		dashboards,
		isLoading,
		readOnly,
		persistenceError,
		updateDashboard,
		updateDashboardTimeRange,
		addWidget,
		cloneWidget,
		removeWidget,
		restoreWidget,
		updateWidgetDisplay,
		updateWidget,
		updateWidgetLayouts,
		autoLayoutWidgets,
	} = useDashboardStore()

	const [chartPickerOpen, setChartPickerOpen] = useAtom(chartPickerOpenAtom)
	const [historyPanelOpen, setHistoryPanelOpen] = useAtom(historyPanelOpenAtom)
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)

	const activeDashboard = dashboards.find((d) => d.id === dashboardId)

	const isPreviewing = previewed !== null
	const mode: WidgetMode = search.mode === "edit" && !readOnly && !isPreviewing ? "edit" : "view"

	// Functional search updates so toggling edit mode never wipes `var-*` params.
	const handleToggleEdit = () => {
		if (isPreviewing) return
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			search: (prev) =>
				mode === "edit"
					? pickVariableParams(prev)
					: { ...pickVariableParams(prev), mode: "edit" as const },
		})
	}

	const urlVariableValues = useMemo(() => variableValuesFromSearch(search), [search])

	const handleVariableChange = (name: string, value: string) => {
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			replace: true,
			search: (prev) => ({
				...pickVariableParams(prev),
				...(prev.mode === "edit" ? { mode: "edit" as const } : {}),
				[`${VARIABLE_PARAM_PREFIX}${name}`]: value,
			}),
		})
	}

	const openHistory = () => {
		setHistoryPanelOpen(true)
	}

	if (!activeDashboard) {
		if (isLoading) {
			return (
				<DashboardLayout
					breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: "..." }]}
				>
					<div className="py-12 text-sm text-muted-foreground">Loading dashboard…</div>
				</DashboardLayout>
			)
		}
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: "Not found" }]}
			>
				<div className="flex flex-col items-center gap-3 py-24">
					<p className="text-sm font-medium text-foreground">Dashboard not found</p>
					<p className="text-xs text-muted-foreground">
						No dashboard with id{" "}
						<code className="break-all rounded bg-muted px-1.5 py-0.5 text-foreground">
							{dashboardId}
						</code>
					</p>
					<Link
						to="/dashboards"
						className="mt-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						← Back to all dashboards
					</Link>
				</div>
			</DashboardLayout>
		)
	}

	return (
		<DashboardTimeRangeWrapper
			key={dashboardId}
			initialTimeRange={activeDashboard.timeRange}
			onTimeRangeChange={(timeRange) => updateDashboardTimeRange(activeDashboard.id, timeRange)}
		>
			<DashboardVariablesProvider
				variables={activeDashboard.variables}
				urlValues={urlVariableValues}
				onValueChange={handleVariableChange}
			>
			<DashboardActionsProvider
				dashboardId={dashboardId}
				mode={mode}
				readOnly={readOnly || isPreviewing}
				store={{
					addWidget,
					removeWidget,
					restoreWidget,
					cloneWidget,
					updateWidgetDisplay,
					updateWidget,
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
									<div className="size-8 rounded bg-primary/15" />
									<div className="size-8 rounded bg-primary/10" />
									<div className="size-8 rounded bg-primary/15" />
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
											search: (prev) => ({
												...pickVariableParams(prev),
												mode: "edit" as const,
											}),
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
			</DashboardVariablesProvider>
		</DashboardTimeRangeWrapper>
	)
}

function HistoryPanelMount({ dashboardId, onClose }: { dashboardId: DashboardId; onClose: () => void }) {
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)
	const result = useDashboardVersions(dashboardId)

	const onPreview = (versionId: DashboardVersionId) => {
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
