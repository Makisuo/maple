import * as React from "react";
import { createFileRoute, useNavigate, useBlocker } from "@tanstack/react-router";

import { Atom, useAtom } from "@/lib/effect-atom";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {
  WidgetQueryBuilderPage,
  type WidgetQueryBuilderPageHandle,
} from "@/components/dashboard-builder/config/widget-query-builder-page";
import { DashboardTimeRangeWrapper } from "@/components/dashboard-builder/dashboard-providers";
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

  const builderRef = React.useRef<WidgetQueryBuilderPageHandle>(null);
  const isDirtyAtom = React.useMemo(() => Atom.make(false), []);
  const [isDirty, setIsDirty] = useAtom(isDirtyAtom);
  const isSavingAtom = React.useMemo(() => Atom.make(false), []);
  const [isSaving, setIsSaving] = useAtom(isSavingAtom);

  const activeDashboard = dashboards.find((d) => d.id === dashboardId);
  const configureWidget = activeDashboard?.widgets.find((w) => w.id === widgetId);

  const navigateBack = () => {
    navigate({
      to: "/dashboards/$dashboardId",
      params: { dashboardId },
      search: { mode: "edit" },
    });
  };

  const handleApply = async (updates: {
    visualization: VisualizationType;
    dataSource: WidgetDataSource;
    display: WidgetDisplayConfig;
  }) => {
    if (readOnly || isSaving) return;
    setIsSaving(true);
    try {
      await updateWidget(dashboardId, widgetId, updates);
      setIsDirty(false);
      navigateBack();
    } finally {
      setIsSaving(false);
    }
  };

  // Block navigation when there are unsaved changes
  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => isDirty && !isSaving,
    withResolver: true,
  });

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
    <DashboardTimeRangeWrapper
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
        }
      >
        <WidgetQueryBuilderPage
          ref={builderRef}
          widget={configureWidget}
          onApply={handleApply}
          onDirtyChange={setIsDirty}
        />
      </DashboardLayout>

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
    </DashboardTimeRangeWrapper>
  );
}
