import { useRef, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardList } from "@/components/dashboard-builder/list/dashboard-list"
import { DashboardCanvas } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { DashboardToolbar } from "@/components/dashboard-builder/toolbar/dashboard-toolbar"
import { WidgetPicker } from "@/components/dashboard-builder/config/chart-picker"
import { WidgetQueryBuilderPage } from "@/components/dashboard-builder/config/widget-query-builder-page"
import { InlineEditableTitle } from "@/components/dashboard-builder/inline-editable-title"
import {
  DashboardTimeRangeProvider,
} from "@/components/dashboard-builder/dashboard-providers"
import {
  parsePortableDashboardJson,
} from "@/components/dashboard-builder/portable-dashboard"
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types"
import { useDashboardStore } from "@/hooks/use-dashboard-store"
import { DashboardAiPanel } from "@/components/dashboard-builder/ai"
import { PlusIcon, UploadIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"

const dashboardsSearchSchema = Schema.Struct({
  dashboardId: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/dashboards")({
  component: DashboardsPage,
  validateSearch: Schema.toStandardSchemaV1(dashboardsSearchSchema),
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
    importDashboard,
    updateDashboard,
    deleteDashboard,
    updateDashboardTimeRange,
    addWidget,
    cloneWidget,
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
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const activeDashboardId = search.dashboardId
  const activeDashboard = dashboards.find((d) => d.id === activeDashboardId)

  const effectiveMode: WidgetMode = readOnly ? "view" : mode

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    // Reset so the same file can be re-imported
    event.target.value = ""

    const reader = new FileReader()
    reader.onload = () => {
      void (async () => {
        try {
          const imported = parsePortableDashboardJson(reader.result as string)
          const dashboard = await importDashboard(imported)
          navigate({ search: { dashboardId: dashboard.id } })
          toast.success(`Dashboard "${dashboard.name}" imported`)
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to parse dashboard file",
          )
        }
      })()
    }
    reader.readAsText(file)
  }

  const handleCreate = () => {
    if (readOnly) return
    void (async () => {
      try {
        const dashboard = await createDashboard("Untitled Dashboard")
        navigate({ search: { dashboardId: dashboard.id } })
        setMode("edit")
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to create dashboard",
        )
      }
    })()
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
    if (mode === "view") setMode("edit")
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

  const handleCloneWidget = (widgetId: string) => {
    if (readOnly) return
    if (!activeDashboardId) return
    cloneWidget(activeDashboardId, widgetId)
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
      visualization: VisualizationType
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
              dashboard={activeDashboard}
              onToggleEdit={() =>
                setMode((current) => (current === "edit" ? "view" : "edit"))
              }
              onAddWidget={() => setChartPickerOpen(true)}
              onAutoLayout={handleAutoLayout}
              onOpenAi={() => setAiPanelOpen(true)}
            />
          }
          rightSidebar={
            aiPanelOpen ? (
              <DashboardAiPanel
                onOpenChange={setAiPanelOpen}
                dashboardId={activeDashboard.id}
                dashboardName={activeDashboard.name}
                widgets={activeDashboard.widgets}
                onAddWidget={handleAddWidget}
                onRemoveWidget={handleRemoveWidget}
              />
            ) : undefined
          }
        >
          {persistenceError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {persistenceError}. Dashboard editing is temporarily disabled.
            </div>
          )}
          {activeDashboard.widgets.length === 0 && effectiveMode === "view" ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="flex gap-2">
                <div className="w-8 h-8 rounded bg-primary/15" />
                <div className="w-8 h-8 rounded bg-primary/10" />
                <div className="w-8 h-8 rounded bg-primary/15" />
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
              onCloneWidget={readOnly ? undefined : handleCloneWidget}
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
      </DashboardTimeRangeProvider>
    )
  }

  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Dashboards" }]}
      title="Dashboards"
      description="Create and manage custom dashboards."
      headerActions={
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => importInputRef.current?.click()}
          >
            <UploadIcon size={14} data-icon="inline-start" />
            Import
          </Button>
          <Button
            size="sm"
            disabled={readOnly}
            onClick={handleCreate}
          >
            <PlusIcon size={14} data-icon="inline-start" />
            Create Dashboard
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
        </div>
      }
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
