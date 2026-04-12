import { useRef, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { DashboardList } from "@/components/dashboard-builder/list/dashboard-list";
import { parsePortableDashboardJson } from "@/components/dashboard-builder/portable-dashboard";
import { useDashboardStore } from "@/hooks/use-dashboard-store";
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences";
import { PlusIcon, UploadIcon } from "@/components/icons";
import { Button } from "@maple/ui/components/ui/button";

export const Route = createFileRoute("/dashboards/")({
  component: DashboardListPage,
});

function DashboardListPage() {
  const navigate = useNavigate();

  const {
    dashboards,
    isLoading,
    readOnly,
    persistenceError,
    createDashboard,
    importDashboard,
    deleteDashboard,
  } = useDashboardStore();

  const {
    favorites,
    sortOption,
    tagFilter,
    toggleFavorite,
    setSortOption,
    setTagFilter,
    sortAndFilter,
    allTags,
  } = useDashboardPreferences();

  const sortedDashboards = useMemo(
    () => sortAndFilter(dashboards),
    [sortAndFilter, dashboards],
  );

  const tags = useMemo(() => allTags(dashboards), [allTags, dashboards]);

  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";

    const reader = new FileReader();
    reader.onload = () => {
      void (async () => {
        try {
          const imported = parsePortableDashboardJson(reader.result as string);
          const dashboard = await importDashboard(imported);
          navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: dashboard.id } });
          toast.success(`Dashboard "${dashboard.name}" imported`);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to parse dashboard file");
        }
      })();
    };
    reader.readAsText(file);
  };

  const handleCreate = () => {
    if (readOnly) return;
    void (async () => {
      try {
        const dashboard = await createDashboard("Untitled Dashboard");
        navigate({
          to: "/dashboards/$dashboardId",
          params: { dashboardId: dashboard.id },
          search: { mode: "edit" },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to create dashboard");
      }
    })();
  };

  const handleSelect = (id: string) => {
    navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: id } });
  };

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
          <Button size="sm" disabled={readOnly} onClick={handleCreate}>
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
        dashboards={sortedDashboards}
        readOnly={readOnly}
        sortOption={sortOption}
        tagFilter={tagFilter}
        allTags={tags}
        favorites={favorites}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={deleteDashboard}
        onToggleFavorite={toggleFavorite}
        onSortChange={setSortOption}
        onTagFilterChange={setTagFilter}
      />
    </DashboardLayout>
  );
}
