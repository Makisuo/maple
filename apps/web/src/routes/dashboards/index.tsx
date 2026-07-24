import { useMemo, useRef } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import { Unitflow, View } from "@maple/unitflow/react"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"

import { DashboardList } from "@/components/dashboard-builder/list/dashboard-list"
import { DashboardListSkeleton } from "@/components/dashboard-builder/loading-skeletons"
import {
	isPersesDashboardJson,
	parsePortableDashboardJson,
} from "@/components/dashboard-builder/portable-dashboard"
import type { Dashboard } from "@/components/dashboard-builder/types"
import { CircleWarningIcon, GridIcon, PlusIcon, UploadIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences"
import { useDashboardMutations } from "@/hooks/use-dashboard-store"
import { DashboardsListModel } from "@/lib/models/dashboards-list-model"
import { unitflowRuntime } from "@/lib/models/runtime"

export const Route = createFileRoute("/dashboards/")({
	component: DashboardListPage,
})

function DashboardListPage() {
	const navigate = useNavigate()

	const {
		readOnly,
		persistenceError,
		createDashboard,
		importDashboard,
		importPersesDashboard,
		deleteDashboard,
	} = useDashboardMutations()

	const importInputRef = useRef<HTMLInputElement>(null)

	const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0]
		if (!file) return
		event.target.value = ""

		const reader = new FileReader()
		reader.onload = () => {
			void (async () => {
				try {
					const raw = reader.result as string
					const parsed = JSON.parse(raw)
					if (isPersesDashboardJson(parsed)) {
						const { dashboard, warnings } = await importPersesDashboard(parsed)
						navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: dashboard.id } })
						toast.success(`Dashboard "${dashboard.name}" imported from Perses`)
						if (warnings.length > 0) {
							const preview = warnings.slice(0, 3).join("\n")
							const suffix = warnings.length > 3 ? `\n+${warnings.length - 3} more` : ""
							toast.warning(
								`Imported with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
								{
									description: `${preview}${suffix}`,
								},
							)
						}
						return
					}

					const imported = parsePortableDashboardJson(raw)
					const dashboard = await importDashboard(imported)
					navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: dashboard.id } })
					toast.success(`Dashboard "${dashboard.name}" imported`)
				} catch (error) {
					toast.error(error instanceof Error ? error.message : "Failed to parse dashboard file")
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
				navigate({
					to: "/dashboards/$dashboardId",
					params: { dashboardId: dashboard.id },
					search: { mode: "edit" },
				})
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to create dashboard")
			}
		})()
	}

	const handleSelect = (id: string) => {
		navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: id } })
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
						onClick={() => navigate({ to: "/dashboards/templates" })}
					>
						<GridIcon size={14} data-icon="inline-start" />
						Browse templates
					</Button>
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
						aria-label="Import dashboard JSON file"
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
			<Unitflow
				runtime={unitflowRuntime}
				rootModel={DashboardsListModel}
				building={<ListLoading />}
				failed={() => <ListLoadError />}
			>
				{(unit) => (
					<ModelListBody
						unit={unit}
						readOnly={readOnly}
						onSelect={handleSelect}
						onCreate={handleCreate}
						onDelete={deleteDashboard}
					/>
				)}
			</Unitflow>
		</DashboardLayout>
	)
}

function ListLoading() {
	return <DashboardListSkeleton />
}

function ListLoadError() {
	return (
		<Empty className="py-12">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<CircleWarningIcon size={18} />
				</EmptyMedia>
				<EmptyTitle>Failed to load dashboards</EmptyTitle>
				<EmptyDescription>Refresh the page or check your connection.</EmptyDescription>
			</EmptyHeader>
		</Empty>
	)
}

interface ListActionProps {
	readonly readOnly: boolean
	readonly onSelect: (id: string) => void
	readonly onCreate: () => void
	readonly onDelete: (id: string) => void
}

const ModelListBody = View.make(DashboardsListModel, ({ list }, actions: ListActionProps) => {
	if (list.phase === "loading") return <ListLoading />
	if (list.phase === "error") return <ListLoadError />
	return <DashboardListContent dashboards={list.dashboards} {...actions} />
})

/**
 * Pure presentation over the derived list: the localStorage-backed preferences
 * (favorites, sort, tag filter) are view concerns and stay here.
 */
function DashboardListContent({
	dashboards,
	readOnly,
	onSelect,
	onCreate,
	onDelete,
}: { readonly dashboards: ReadonlyArray<Dashboard> } & ListActionProps) {
	const {
		favorites,
		sortOption,
		tagFilter,
		toggleFavorite,
		setSortOption,
		setTagFilter,
		sortAndFilter,
		allTags,
	} = useDashboardPreferences()

	const sortedDashboards = useMemo(() => sortAndFilter(dashboards), [sortAndFilter, dashboards])

	const tags = useMemo(() => allTags(dashboards), [allTags, dashboards])

	return (
		<DashboardList
			dashboards={sortedDashboards}
			readOnly={readOnly}
			sortOption={sortOption}
			tagFilter={tagFilter}
			allTags={tags}
			favorites={favorites}
			onSelect={onSelect}
			onCreate={onCreate}
			onDelete={onDelete}
			onToggleFavorite={toggleFavorite}
			onSortChange={setSortOption}
			onTagFilterChange={setTagFilter}
		/>
	)
}
