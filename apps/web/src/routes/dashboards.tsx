import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardList } from "@/components/dashboard-builder/list/dashboard-list"
import { DashboardCanvas } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { DashboardToolbar } from "@/components/dashboard-builder/toolbar/dashboard-toolbar"
import { WidgetPicker } from "@/components/dashboard-builder/config/chart-picker"
import { WidgetQueryBuilderPage } from "@/components/dashboard-builder/config/widget-query-builder-page"
import { InlineEditableTitle } from "@/components/dashboard-builder/inline-editable-title"
import {
  DashboardTimeRangeProvider,
  DashboardVariablesProvider,
} from "@/components/dashboard-builder/dashboard-providers"
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"

const dashboardsSearchSchema = Schema.Struct({
  dashboardId: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/dashboards")({
  component: DashboardsPage,
  validateSearch: Schema.standardSchemaV1(dashboardsSearchSchema),
})

function DashboardsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const {
    dashboards,
    isLoading,
    readOnly,
    persistenceError,
    createDashboard,
    updateDashboard,
    deleteDashboard,
    updateDashboardTimeRange,
    addWidget,
    removeWidget,
    updateWidgetDisplay,
    updateWidgetLayouts,
    updateWidget,
    autoLayoutWidgets,
  } = useDashboardStore()

  const [mode, setMode] = useState<WidgetMode>("view")
  const [chartPickerOpen, setChartPickerOpen] = useState(false)
  const [configureWidgetId, setConfigureWidgetId] = useState<string | null>(null)
  const [configureOpen, setConfigureOpen] = useState(false)

  const activeDashboardId = search.dashboardId
  const activeDashboard = dashboards.find((d) => d.id === activeDashboardId)

  const effectiveMode: WidgetMode = readOnly ? "view" : mode

  const handleCreate = () => {
    if (readOnly) return
    const dashboard = createDashboard("Untitled Dashboard")
    navigate({ search: { dashboardId: dashboard.id } })
    setMode("edit")
  }

  const handleSelect = (id: string) => {
    navigate({ search: { dashboardId: id } })
    setMode("view")
  }

  const handleAddWidget = (
    visualization: VisualizationType,
    dataSource: WidgetDataSource,
    display: WidgetDisplayConfig
  ) => {
    if (readOnly) return
    if (!activeDashboardId) return
    addWidget(activeDashboardId, visualization, dataSource, display)
  }

  const handleLayoutChange = (
    layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>
  ) => {
    if (readOnly) return
    if (!activeDashboardId) return
    updateWidgetLayouts(activeDashboardId, layouts)
  }

  const handleRemoveWidget = (widgetId: string) => {
    if (readOnly) return
    if (!activeDashboardId) return
    removeWidget(activeDashboardId, widgetId)
  }

  const handleUpdateWidgetDisplay = (
    widgetId: string,
    display: Partial<WidgetDisplayConfig>
  ) => {
    if (readOnly) return
    if (!activeDashboardId) return
    updateWidgetDisplay(activeDashboardId, widgetId, display)
  }

  const handleConfigureWidget = (widgetId: string) => {
    if (readOnly) return
    setConfigureWidgetId(widgetId)
    setConfigureOpen(true)
  }

  const handleAutoLayout = () => {
    if (readOnly) return
    if (!activeDashboardId) return
    autoLayoutWidgets(activeDashboardId)
  }

  const handleApplyWidgetConfig = (
    widgetId: string,
    updates: {
      dataSource: WidgetDataSource
      display: WidgetDisplayConfig
    }
  ) => {
    if (readOnly) return
    if (!activeDashboardId) return
    updateWidget(activeDashboardId, widgetId, updates)
  }

  if (activeDashboard) {
    const configureWidget =
      activeDashboard.widgets.find((widget) => widget.id === configureWidgetId) ??
      null

    const handleCloseBuilder = () => {
      setConfigureOpen(false)
      setConfigureWidgetId(null)
    }

    if (!readOnly && configureOpen && configureWidget) {
      return (
        <DashboardTimeRangeProvider
          initialTimeRange={activeDashboard.timeRange}
          onTimeRangeChange={(timeRange) =>
            updateDashboardTimeRange(activeDashboard.id, timeRange)
          }
        >
          <DashboardVariablesProvider
            variables={activeDashboard.variables ?? []}
          >
            <DashboardLayout
              breadcrumbs={[
                { label: "Dashboards", href: "/dashboards" },
                {
                  label: activeDashboard.name,
                  href: `/dashboards?dashboardId=${activeDashboard.id}`,
                },
                { label: "Configure Widget" },
              ]}
            >
              <WidgetQueryBuilderPage
                widget={configureWidget}
                onApply={(updates) => {
                  handleApplyWidgetConfig(configureWidget.id, updates)
                  handleCloseBuilder()
                }}
                onCancel={handleCloseBuilder}
              />
            </DashboardLayout>
          </DashboardVariablesProvider>
        </DashboardTimeRangeProvider>
      )
    }

    return (
      <DashboardTimeRangeProvider
        initialTimeRange={activeDashboard.timeRange}
        onTimeRangeChange={(timeRange) =>
          updateDashboardTimeRange(activeDashboard.id, timeRange)
        }
      >
        <DashboardVariablesProvider
          variables={activeDashboard.variables ?? []}
        >
          <DashboardLayout
            breadcrumbs={[
              { label: "Dashboards", href: "/dashboards" },
              { label: activeDashboard.name },
            ]}
            titleContent={
              <InlineEditableTitle
                value={activeDashboard.name}
                readOnly={readOnly}
                onChange={(name) =>
                  updateDashboard(activeDashboardId!, { name })
                }
              />
            }
            description="Custom dashboard"
            headerActions={
              <DashboardToolbar
                mode={effectiveMode}
                readOnly={readOnly}
                onToggleEdit={() =>
                  setMode((current) => (current === "edit" ? "view" : "edit"))
                }
                onAddWidget={() => setChartPickerOpen(true)}
                onAutoLayout={handleAutoLayout}
              />
            }
          >
            {persistenceError && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {persistenceError}. Dashboard editing is temporarily disabled.
              </div>
            )}
            {activeDashboard.widgets.length === 0 && effectiveMode === "view" ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
                <p className="text-sm">This dashboard is empty.</p>
                <button
                  type="button"
                  disabled={readOnly}
                  className="text-xs text-primary hover:underline"
                  onClick={() => {
                    setMode("edit")
                    setChartPickerOpen(true)
                  }}
                >
                  Add your first widget
                </button>
              </div>
            ) : (
              <DashboardCanvas
                widgets={activeDashboard.widgets}
                mode={effectiveMode}
                onLayoutChange={handleLayoutChange}
                onRemoveWidget={handleRemoveWidget}
                onUpdateWidgetDisplay={handleUpdateWidgetDisplay}
                onConfigureWidget={readOnly ? undefined : handleConfigureWidget}
              />
            )}

            <WidgetPicker
              open={readOnly ? false : chartPickerOpen}
              onOpenChange={readOnly ? () => undefined : setChartPickerOpen}
              onSelect={handleAddWidget}
            />
          </DashboardLayout>
        </DashboardVariablesProvider>
      </DashboardTimeRangeProvider>
    )
  }

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Dashboards" }]}
      title="Dashboards"
      description="Create and manage custom dashboards."
    >
      {persistenceError && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {persistenceError}. Dashboard editing is temporarily disabled.
        </div>
      )}
      {isLoading && dashboards.length === 0 ? (
        <div className="py-12 text-sm text-muted-foreground">Loading dashboards...</div>
      ) : null}
      <DashboardList
        dashboards={dashboards}
        readOnly={readOnly}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={deleteDashboard}
      />
    </DashboardLayout>
  )
}
