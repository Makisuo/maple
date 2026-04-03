import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect";
import { Atom, useAtom } from "@/lib/effect-atom";

import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { DashboardCanvas } from "@/components/dashboard-builder/canvas/dashboard-canvas";
import { DashboardToolbar } from "@/components/dashboard-builder/toolbar/dashboard-toolbar";
import { WidgetPicker } from "@/components/dashboard-builder/config/chart-picker";
import { InlineEditableTitle } from "@/components/dashboard-builder/inline-editable-title";
import { DashboardTimeRangeWrapper } from "@/components/dashboard-builder/dashboard-providers";
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
  WidgetMode,
} from "@/components/dashboard-builder/types";
import { useDashboardStore } from "@/hooks/use-dashboard-store";
import { DashboardAiPanel } from "@/components/dashboard-builder/ai";

// Module-level atoms — singleton (only one dashboard page visible at a time)
const chartPickerOpenAtom = Atom.make(false)
const aiPanelOpenAtom = Atom.make(false)

const dashboardViewSearchSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literal("edit")),
});

export const Route = effectRoute(createFileRoute("/dashboards/$dashboardId"))({
  component: DashboardViewPage,
  validateSearch: Schema.toStandardSchemaV1(dashboardViewSearchSchema),
});

function DashboardViewPage() {
  const { dashboardId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();

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
  } = useDashboardStore();

  const [chartPickerOpen, setChartPickerOpen] = useAtom(chartPickerOpenAtom);
  const [aiPanelOpen, setAiPanelOpen] = useAtom(aiPanelOpenAtom);

  const activeDashboard = dashboards.find((d) => d.id === dashboardId);

  const mode: WidgetMode = search.mode === "edit" && !readOnly ? "edit" : "view";

  const handleToggleEdit = () => {
    navigate({
      to: "/dashboards/$dashboardId",
      params: { dashboardId },
      search: mode === "edit" ? {} : { mode: "edit" },
    });
  };

  const handleAddWidget = (
    visualization: VisualizationType,
    dataSource: WidgetDataSource,
    display: WidgetDisplayConfig,
  ) => {
    if (readOnly) return;
    addWidget(dashboardId, visualization, dataSource, display);
    if (mode === "view") {
      navigate({
        to: "/dashboards/$dashboardId",
        params: { dashboardId },
        search: { mode: "edit" },
      });
    }
  };

  const handleLayoutChange = (
    layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>,
  ) => {
    if (readOnly) return;
    updateWidgetLayouts(dashboardId, layouts);
  };

  const handleRemoveWidget = (widgetId: string) => {
    if (readOnly) return;
    removeWidget(dashboardId, widgetId);
  };

  const handleCloneWidget = (widgetId: string) => {
    if (readOnly) return;
    cloneWidget(dashboardId, widgetId);
  };

  const handleUpdateWidgetDisplay = (widgetId: string, display: Partial<WidgetDisplayConfig>) => {
    if (readOnly) return;
    updateWidgetDisplay(dashboardId, widgetId, display);
  };

  const handleConfigureWidget = (widgetId: string) => {
    if (readOnly) return;
    navigate({
      to: "/dashboards/$dashboardId/widgets/$widgetId",
      params: { dashboardId, widgetId },
    });
  };

  const handleAutoLayout = () => {
    if (readOnly) return;
    autoLayoutWidgets(dashboardId);
  };

  if (!activeDashboard) {
    return (
      <DashboardLayout
        breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: "..." }]}
      >
        <div className="py-12 text-sm text-muted-foreground">Loading dashboard...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardTimeRangeWrapper
      initialTimeRange={activeDashboard.timeRange}
      onTimeRangeChange={(timeRange) => updateDashboardTimeRange(activeDashboard.id, timeRange)}
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
            onChange={(name) => updateDashboard(dashboardId, { name })}
          />
        }

        headerActions={
          <DashboardToolbar
            mode={mode}
            readOnly={readOnly}
            dashboard={activeDashboard}
            onToggleEdit={handleToggleEdit}
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
        {activeDashboard.widgets.length === 0 && mode === "view" ? (
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
                });
                setChartPickerOpen(true);
              }}
            >
              Add your first widget
            </button>
          </div>
        ) : (
          <DashboardCanvas
            widgets={activeDashboard.widgets}
            mode={mode}
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
    </DashboardTimeRangeWrapper>
  );
}
