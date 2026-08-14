import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { DashboardId, DashboardVersionId } from "@maple/domain/http"
import { Atom, useAtom } from "@/lib/effect-atom"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardSections } from "@/components/dashboard-builder/sections/dashboard-sections"
import {
	withActiveTab,
	withSectionCollapsed,
	type SectionViewSearch,
} from "@/lib/dashboards/section-view-state"
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
	dashboardViewParamsSchema,
	pickDashboardControlParams,
	variableSearchRest,
} from "@/lib/dashboard-controls/search-params"
import {
	DashboardActionsProvider,
	useDashboardActions,
} from "@/components/dashboard-builder/dashboard-actions-context"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import type { WidgetMode } from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { DashboardHistoryPanel, PreviewedCanvas } from "@/components/dashboard-builder/history"
import { DashboardViewSkeleton } from "@/components/dashboard-builder/loading-skeletons"
import { SyncDegradedBanner, SyncUnavailable } from "@/components/common/sync-unavailable"
import { historyPanelOpenAtom, previewedVersionAtom } from "@/atoms/dashboard-history-atoms"
import { useDashboardVersions } from "@/components/dashboard-builder/history/use-dashboard-history"
import { Result } from "@/lib/effect-atom"
import { useMemo, useState, type ReactNode } from "react"
import type { SectionTarget } from "@maple/domain/http"

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
		...dashboardViewParamsSchema,
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

export const Route = createFileRoute("/dashboards/$dashboardId")({
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
		isError,
		degraded,
		retry,
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
		addSection,
		renameSection,
		setSectionCollapsedDefault,
		setSectionCollapsible,
		reorderSections,
		deleteSection,
		addTab,
		renameTab,
		deleteTab,
		moveWidgetToSection,
	} = useDashboardStore()

	const [chartPickerOpen, setChartPickerOpen] = useAtom(chartPickerOpenAtom)
	// Which grid the picker's next widget lands in. Set by a group's own "+",
	// cleared by the toolbar's, so the two entry points can't drift.
	const [pendingSectionTarget, setPendingSectionTarget] = useState<SectionTarget>(null)
	const [historyPanelOpen, setHistoryPanelOpen] = useAtom(historyPanelOpenAtom)
	const [previewed, setPreviewed] = useAtom(previewedVersionAtom)

	const activeDashboard = dashboards.find((d) => d.id === dashboardId)

	const isPreviewing = previewed !== null
	const mode: WidgetMode = search.mode === "edit" && !readOnly && !isPreviewing ? "edit" : "view"

	// Functional search updates so toggling edit mode never wipes the per-viewer
	// controls (`var-*` selections, filter clause, section collapse, active tabs).
	const handleToggleEdit = () => {
		if (isPreviewing) return
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			search: (prev) =>
				mode === "edit"
					? pickDashboardControlParams(prev)
					: { ...pickDashboardControlParams(prev), mode: "edit" as const },
		})
	}

	const urlVariableValues = useMemo(() => variableValuesFromSearch(search), [search])

	const handleVariableChange = (name: string, value: string) => {
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			replace: true,
			search: (prev) => ({
				...pickDashboardControlParams(prev),
				...(prev.mode === "edit" ? { mode: "edit" as const } : {}),
				[`${VARIABLE_PARAM_PREFIX}${name}`]: value,
			}),
		})
	}

	const openHistory = () => {
		setHistoryPanelOpen(true)
	}

	// Section view state is per-viewer: it rides the URL with `replace` so
	// collapsing a group doesn't fill the back button with layout noise, and it
	// never touches the stored document.
	//
	// The update is applied *to* the picked params rather than spread over them.
	// `withSectionCollapsed` signals "drop this key" by deleting it from the
	// object it returns, and `{...base, ...update(prev)}` silently undoes that —
	// the deleted key simply isn't there to overwrite the stale value, so an id
	// toggled twice ends up in both `collapsed` and `expanded`, and `expanded`
	// wins, pinning the group open forever.
	//
	// `mode` is re-added for the same class of reason: `pickDashboardControlParams`
	// deliberately drops it, so without this, collapsing a group while editing
	// would quietly kick the user out of edit mode.
	const applySectionView = (update: (prev: SectionViewSearch) => SectionViewSearch) => {
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			replace: true,
			search: (prev) => ({
				...update(pickDashboardControlParams(prev)),
				...(prev.mode === "edit" ? { mode: "edit" as const } : {}),
			}),
		})
	}

	const sectionViewSearch: SectionViewSearch = {
		collapsed: search.collapsed,
		expanded: search.expanded,
		tab: search.tab,
		widget: search.widget,
	}

	if (!activeDashboard) {
		if (isLoading) {
			return (
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs
						items={[{ label: "Dashboards", href: "/dashboards" }, { label: "..." }]}
					/>
					<DashboardLayout.Body>
						<DashboardLayout.Content>
							<DashboardLayout.Scroll>
								<DashboardViewSkeleton />
							</DashboardLayout.Scroll>
						</DashboardLayout.Content>
					</DashboardLayout.Body>
				</DashboardLayout.Root>
			)
		}
		// A dead sync stream must not masquerade as a missing dashboard: the row may
		// exist and simply never have arrived.
		if (isError) {
			return (
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs
						items={[{ label: "Dashboards", href: "/dashboards" }, { label: "Unavailable" }]}
					/>
					<DashboardLayout.Body>
						<DashboardLayout.Content>
							<DashboardLayout.Scroll>
								<SyncUnavailable
									title="Couldn’t load this dashboard"
									description="The sync stream isn’t reachable, so the dashboard couldn’t be read. Nothing has been lost — this is a read problem."
									onRetry={retry}
								/>
							</DashboardLayout.Scroll>
						</DashboardLayout.Content>
					</DashboardLayout.Body>
				</DashboardLayout.Root>
			)
		}
		return (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Dashboards", href: "/dashboards" }, { label: "Not found" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Scroll>
							<div className="flex flex-col items-center gap-3 px-4 py-24 text-center">
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
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
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
					sections={activeDashboard.sections ?? []}
					store={{
						addWidget,
						removeWidget,
						restoreWidget,
						cloneWidget,
						updateWidgetDisplay,
						updateWidget,
						updateWidgetLayouts,
						autoLayoutWidgets,
						addSection,
						renameSection,
						setSectionCollapsedDefault,
						setSectionCollapsible,
						reorderSections,
						deleteSection,
						addTab,
						renameTab,
						deleteTab,
						moveWidgetToSection,
					}}
				>
					<DashboardRefreshBridge>
						<DashboardLayout.Root>
							<DashboardLayout.Breadcrumbs
								items={[
									{ label: "Dashboards", href: "/dashboards" },
									{ label: activeDashboard.name },
								]}
							/>
							<DashboardLayout.Body>
								<DashboardLayout.Content>
									<DashboardLayout.Sticky>
										<DashboardLayout.Header
											titleContent={
												<InlineEditableTitle
													value={activeDashboard.name}
													readOnly={readOnly || isPreviewing}
													onChange={(name) =>
														updateDashboard(dashboardId, { name })
													}
												/>
											}
										>
											<DashboardToolbar
												dashboard={activeDashboard}
												onToggleEdit={handleToggleEdit}
												onAddWidget={() => setChartPickerOpen(true)}
												onOpenHistory={openHistory}
											/>
										</DashboardLayout.Header>
									</DashboardLayout.Sticky>
									<DashboardLayout.Scroll>
										{degraded && <SyncDegradedBanner onRetry={retry} />}
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
										) : activeDashboard.widgets.length === 0 &&
										  (activeDashboard.sections?.length ?? 0) === 0 &&
										  mode === "view" ? (
											<div className="flex flex-col items-center justify-center gap-4 px-4 py-24 text-center">
												<div className="flex gap-2">
													<div className="size-8 rounded bg-primary/15" />
													<div className="size-8 rounded bg-primary/10" />
													<div className="size-8 rounded bg-primary/15" />
												</div>
												<div className="flex flex-col items-center gap-1">
													<p className="text-sm font-medium text-foreground">
														No widgets yet
													</p>
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
																...pickDashboardControlParams(prev),
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
											<DashboardSections
												widgets={activeDashboard.widgets}
												sections={activeDashboard.sections ?? []}
												search={sectionViewSearch}
												onToggleCollapsed={(sectionId, collapsed) =>
													applySectionView((prev) =>
														withSectionCollapsed(prev, sectionId, collapsed),
													)
												}
												onSelectTab={(sectionId, tabId) =>
													applySectionView((prev) =>
														withActiveTab(prev, sectionId, tabId),
													)
												}
												onAddWidget={(sectionId, tabId) => {
													setPendingSectionTarget({ sectionId, tabId })
													setChartPickerOpen(true)
												}}
											/>
										)}

										<WidgetPickerWithActions
											open={readOnly || isPreviewing ? false : chartPickerOpen}
											target={pendingSectionTarget}
											onOpenChange={
												readOnly || isPreviewing
													? () => undefined
													: (open) => {
															setChartPickerOpen(open)
															// Reset on close so the next toolbar "Add
															// widget" lands on the root canvas rather
															// than inheriting the last group used.
															if (!open) setPendingSectionTarget(null)
														}
											}
										/>
									</DashboardLayout.Scroll>
								</DashboardLayout.Content>
								<DashboardLayout.RightPanel>
									{historyPanelOpen ? (
										<HistoryPanelMount
											dashboardId={dashboardId}
											onClose={() => {
												setHistoryPanelOpen(false)
												setPreviewed(null)
											}}
										/>
									) : undefined}
								</DashboardLayout.RightPanel>
							</DashboardLayout.Body>
						</DashboardLayout.Root>
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
		const version = result.value.data.find((v) => v.id === versionId)
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
	target,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Which grid the chosen widget lands in; `null` is the root canvas. */
	target: SectionTarget
}) {
	const { addWidget } = useDashboardActions()
	return (
		<WidgetPicker
			open={open}
			onOpenChange={onOpenChange}
			onSelect={(visualization, dataSource, display) =>
				addWidget(visualization, dataSource, display, target)
			}
		/>
	)
}
