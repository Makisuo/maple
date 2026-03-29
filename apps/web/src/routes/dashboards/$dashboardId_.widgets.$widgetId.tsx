import { useRef } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  WidgetQueryBuilderPage,
  type WidgetQueryBuilderPageHandle,
} from "@/components/dashboard-builder/config/widget-query-builder-page";
import { DashboardTimeRangeProvider } from "@/components/dashboard-builder/dashboard-providers";
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types";
import { useDashboardStore } from "@/hooks/use-dashboard-store";
import { Button } from "@maple/ui/components/ui/button";

export const Route = createFileRoute("/dashboards/$dashboardId_/widgets/$widgetId")({
  component: WidgetConfigurePage,
});

function WidgetConfigurePage() {
  const { dashboardId, widgetId } = Route.useParams();
  const navigate = useNavigate();

  const { dashboards, readOnly, updateWidget, updateDashboardTimeRange } = useDashboardStore();

  const builderRef = useRef<WidgetQueryBuilderPageHandle>(null);

  const activeDashboard = dashboards.find((d) => d.id === dashboardId);
  const configureWidget = activeDashboard?.widgets.find((w) => w.id === widgetId);

  const navigateBack = () => {
    navigate({
      to: "/dashboards/$dashboardId",
      params: { dashboardId },
      search: { mode: "edit" },
    });
  };

  const handleApply = (updates: {
    visualization: VisualizationType;
    dataSource: WidgetDataSource;
    display: WidgetDisplayConfig;
  }) => {
    if (readOnly) return;
    updateWidget(dashboardId, widgetId, updates);
    navigateBack();
  };

  if (!activeDashboard || !configureWidget) {
    return (
      <DashboardLayout
        breadcrumbs={[{ label: "Dashboards", href: "/dashboards" }, { label: "..." }]}
      >
        <div className="py-12 text-sm text-muted-foreground">Loading widget...</div>
      </DashboardLayout>
    );
  }

  if (readOnly) {
    navigateBack();
    return null;
  }

  return (
    <DashboardTimeRangeProvider
      initialTimeRange={activeDashboard.timeRange}
      onTimeRangeChange={(timeRange) => updateDashboardTimeRange(activeDashboard.id, timeRange)}
    >
      <DashboardLayout
        breadcrumbs={[
          { label: "Dashboards", href: "/dashboards" },
          {
            label: activeDashboard.name,
            href: `/dashboards/${activeDashboard.id}`,
          },
          { label: "Configure Widget" },
        ]}
        breadcrumbActions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={navigateBack}>
              &larr; Back
            </Button>
            <Button variant="outline" size="sm" onClick={navigateBack}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => builderRef.current?.apply()}>
              Apply
            </Button>
          </div>
        }
      >
        <WidgetQueryBuilderPage ref={builderRef} widget={configureWidget} onApply={handleApply} />
      </DashboardLayout>
    </DashboardTimeRangeProvider>
  );
}
