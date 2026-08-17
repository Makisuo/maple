import * as React from "react"
import { createFileRoute, useNavigate, useBlocker } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
	WidgetQueryBuilderPage,
	type WidgetQueryBuilderPageHandle,
} from "@/components/dashboard-builder/config/widget-query-builder-page"
import { WidgetBuilderProvider } from "@/components/dashboard-builder/config/widget-builder-provider"
import { DashboardTimeRangeWrapper } from "@/components/dashboard-builder/dashboard-providers"
import { DashboardVariablesProvider } from "@/components/dashboard-builder/dashboard-variables-context"
import type {
	TimeRange,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { WidgetEditorSkeleton } from "@/components/dashboard-builder/loading-skeletons"
import {
	dashboardViewParamsSchema,
	pickDashboardControlParams,
	variableSearchRest,
} from "@/lib/dashboard-controls/search-params"
import { Button } from "@maple/ui/components/ui/button"
import { toastManager } from "@maple/ui/components/ui/toast"

// The editor carries the dashboard's per-viewer controls through its own search
// (as opaque pass-through — it renders variables at defaults) so returning to the
// dashboard restores them instead of falling back to first-option values. The
// view params have to be declared here, not just picked: TanStack drops any
// search key the route's schema doesn't accept, so a section left collapsed
// would silently re-expand on the way back.
export const Route = createFileRoute("/dashboards/$dashboardId_/widgets/$widgetId")({
	component: WidgetConfigurePage,
	validateSearch: Schema.toStandardSchemaV1(
		Schema.StructWithRest(Schema.Struct(dashboardViewParamsSchema), [variableSearchRest]),
	),
})

function WidgetConfigurePage() {
	const { dashboardId, widgetId } = Route.useParams()
	const navigate = useNavigate()

	const { dashboards, readOnly, updateWidget, updateDashboardTimeRange } = useDashboardStore()

	const builderRef = React.useRef<WidgetQueryBuilderPageHandle>(null)
	const [isSaving, setIsSaving] = React.useState(false)
	// Stabilize time range value — only update when the value actually changes,
	// not when the dashboard object is rebuilt (e.g. from widget save optimistic update).
	// Without this, DashboardTimeRangeSync fires spurious mutations that overwrite concurrent saves.
	const [stableTimeRange, setStableTimeRange] = React.useState<TimeRange | null>(null)

	const activeDashboard = dashboards.find((d) => d.id === dashboardId)
	const configureWidget = activeDashboard?.widgets.find((w) => w.id === widgetId)

	const navigateBack = () => {
		navigate({
			to: "/dashboards/$dashboardId",
			params: { dashboardId },
			// Restore the controls the editor round-tripped, back into edit mode.
			search: (prev) => ({ ...pickDashboardControlParams(prev), mode: "edit" as const }),
		})
	}

	const handleApply = async (updates: {
		visualization: VisualizationType
		dataSource: WidgetDataSource
		display: WidgetDisplayConfig
		timeRange: TimeRange | undefined
	}) => {
		if (readOnly || isSaving) return
		setIsSaving(true)
		try {
			await updateWidget(dashboardId, widgetId, updates)
			navigateBack()
		} catch (cause) {
			// `onApply` is a fire-and-forget callback, so an uncaught rejection here
			// would strand the user on the editor with no idea the save failed.
			toastManager.add({
				title: cause instanceof Error ? cause.message : "Couldn’t save this widget",
				type: "error",
			})
		} finally {
			setIsSaving(false)
		}
	}

	// Block navigation when there are unsaved changes
	const { proceed, reset, status } = useBlocker({
		shouldBlockFn: () => !isSaving && (builderRef.current?.isDirty() ?? false),
		withResolver: true,
	})

	if (!activeDashboard || !configureWidget) {
		return (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Dashboards", href: "/dashboards" }, { label: "..." }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Scroll>
							<WidgetEditorSkeleton />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		)
	}

	if (readOnly) {
		navigateBack()
		return null
	}

	let initialTimeRange = stableTimeRange
	if (
		initialTimeRange === null ||
		JSON.stringify(initialTimeRange) !== JSON.stringify(activeDashboard.timeRange)
	) {
		initialTimeRange = activeDashboard.timeRange
		setStableTimeRange(initialTimeRange)
	}

	return (
		<DashboardTimeRangeWrapper
			initialTimeRange={initialTimeRange}
			onTimeRangeChange={(timeRange) => updateDashboardTimeRange(activeDashboard.id, timeRange)}
		>
			{/* Variables resolve to their defaults here so previews of queries
		    referencing `$name` run against real values while editing. */}
			<DashboardVariablesProvider
				variables={activeDashboard.variables}
				urlValues={{}}
				onValueChange={() => undefined}
			>
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs
						items={[
							{ label: "Dashboards", href: "/dashboards" },
							{
								label: activeDashboard.name,
								href: `/dashboards/${activeDashboard.id}`,
							},
							{ label: "Configure Widget" },
						]}
					>
						<div className="flex items-center gap-2">
							<Button variant="ghost" size="sm" onClick={navigateBack} disabled={isSaving}>
								&larr; Back
							</Button>
							<Button variant="outline" size="sm" onClick={navigateBack} disabled={isSaving}>
								Cancel
							</Button>
							<Button size="sm" onClick={() => builderRef.current?.apply()} disabled={isSaving}>
								{isSaving ? "Saving..." : "Apply"}
							</Button>
						</div>
					</DashboardLayout.Breadcrumbs>
					<DashboardLayout.Body>
						<DashboardLayout.Content>
							<DashboardLayout.Scroll>
								<WidgetBuilderProvider widget={configureWidget}>
									<WidgetQueryBuilderPage
										ref={builderRef}
										widget={configureWidget}
										onApply={handleApply}
									/>
								</WidgetBuilderProvider>
							</DashboardLayout.Scroll>
						</DashboardLayout.Content>
					</DashboardLayout.Body>
				</DashboardLayout.Root>

				{status === "blocked" && (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
						<div className="bg-background rounded-lg border p-6 shadow-lg max-w-sm">
							<h3 className="text-sm font-medium mb-2">Unsaved changes</h3>
							<p className="text-sm text-muted-foreground mb-4">
								You have unsaved widget changes. Are you sure you want to leave?
							</p>
							<div className="flex justify-end gap-2">
								<Button variant="outline" size="sm" onClick={reset}>
									Stay
								</Button>
								<Button variant="destructive" size="sm" onClick={proceed}>
									Discard changes
								</Button>
							</div>
						</div>
					</div>
				)}
			</DashboardVariablesProvider>
		</DashboardTimeRangeWrapper>
	)
}
