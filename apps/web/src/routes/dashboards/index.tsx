import { useRef } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { toast } from "sonner"

import { Unitflow, View } from "@maple/unitflow/react"
import { Button } from "@maple/ui/components/ui/button"
import { formatRelativeTimeOrDate } from "@maple/ui/time-format"

import { DashboardList, type DashboardScope } from "@/components/dashboard-builder/list/dashboard-list"
import { headerSummary } from "@/components/dashboard-builder/list/dashboard-summary"
import { DashboardListSkeleton } from "@/components/dashboard-builder/loading-skeletons"
import { SyncDegradedBanner, SyncUnavailable } from "@/components/common/sync-unavailable"
import {
	downloadPortableDashboard,
	isPersesDashboardJson,
	parsePortableDashboardJson,
	toPortableDashboard,
} from "@/components/dashboard-builder/portable-dashboard"
import type { Dashboard } from "@/components/dashboard-builder/types"
import { CircleWarningIcon, GridIcon, PlusIcon, UploadIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { isDashboardSortOption, type DashboardSortOption } from "@/atoms/dashboard-preferences-atoms"
import { useDashboardPreferences } from "@/hooks/use-dashboard-preferences"
import { useDashboardMutations } from "@/hooks/use-dashboard-store"
import { retryOrgCollections } from "@/lib/collections/org-collections"
import { DashboardsListModel } from "@/lib/models/dashboards-list-model"
import { unitflowRuntime } from "@/lib/models/runtime"

/**
 * Search, scope, tags and sort all live in the URL so the view is shareable and
 * survives back/forward — matching `routes/dashboards/templates.tsx`. Retires the
 * in-memory tag atom, which was neither persisted nor linkable.
 *
 * `Schema.optional`, not `optionalKey`: these are search params, where
 * `undefined` is a real value meaning "absent".
 */
const dashboardsSearchSchema = Schema.Struct({
	q: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Literals(["all", "favorites"])),
	tags: Schema.optional(Schema.Array(Schema.String)),
	sort: Schema.optional(Schema.Literals(["updated", "created", "name-asc", "name-desc", "widgets"])),
})

export const Route = createFileRoute("/dashboards/")({
	component: DashboardListPage,
	validateSearch: Schema.toStandardSchemaV1(dashboardsSearchSchema),
})

/** Everything the list needs that isn't the dashboards themselves. */
type ListBinding = Omit<React.ComponentProps<typeof DashboardList>, "dashboards">

function DashboardListPage() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

	const {
		readOnly,
		persistenceError,
		createDashboard,
		importDashboard,
		importPersesDashboard,
		deleteDashboard,
		updateDashboard,
	} = useDashboardMutations()

	const { favorites, toggleFavorite, defaultSort, setDefaultSort } = useDashboardPreferences()

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

	/**
	 * Round-trips the dashboard through its own portable form, so a duplicate goes
	 * through exactly the import path a file would — no second server endpoint, and
	 * no risk of copying fields the importer would have stripped.
	 */
	const handleDuplicate = (dashboard: Dashboard) => {
		if (readOnly) return
		void (async () => {
			try {
				const portable = toPortableDashboard(dashboard)
				const copy = await importDashboard({ ...portable, name: `${dashboard.name} copy` })
				navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: copy.id } })
				toast.success(`Duplicated as "${copy.name}"`)
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "Failed to duplicate dashboard")
			}
		})()
	}

	// `undefined` clears the param instead of writing an empty value, so a cleared
	// filter leaves no trace in the URL. `replace` keeps filter churn out of history.
	const setSearchParam = (key: keyof typeof search, value: unknown) => {
		navigate({ search: (prev) => ({ ...prev, [key]: value }), replace: true })
	}

	const binding: ListBinding = {
		readOnly,
		favorites,
		query: search.q ?? "",
		scope: (search.scope ?? "all") as DashboardScope,
		tags: search.tags ?? [],
		sort: search.sort ?? (isDashboardSortOption(defaultSort) ? defaultSort : "updated"),
		onQueryChange: (q) => setSearchParam("q", q),
		onScopeChange: (scope) => setSearchParam("scope", scope === "all" ? undefined : scope),
		onTagsChange: (tags) => setSearchParam("tags", tags.length === 0 ? undefined : tags),
		onSortChange: (next: DashboardSortOption) => {
			// The URL owns the active sort; localStorage remembers it as the default
			// for the next cold load.
			setDefaultSort(next)
			setSearchParam("sort", next)
		},
		onCreate: handleCreate,
		onDelete: deleteDashboard,
		onDuplicate: handleDuplicate,
		onExport: downloadPortableDashboard,
		onSaveTags: (dashboard, tags) => {
			if (readOnly) return
			updateDashboard(dashboard.id, { tags })
		},
		onToggleFavorite: toggleFavorite,
	}

	const actions = (
		<div className="flex items-center gap-1">
			<Button variant="outline" size="sm" onClick={() => navigate({ to: "/dashboards/templates" })}>
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
	)

	// One Unitflow around header *and* body: the header readout counts the same
	// dashboards the list renders, so mounting the model twice would be wasteful
	// and could show a header that disagrees with the rows beneath it.
	return (
		<Unitflow
			runtime={unitflowRuntime}
			rootModel={DashboardsListModel}
			building={
				<PageShell actions={actions} persistenceError={persistenceError}>
					<DashboardListSkeleton />
				</PageShell>
			}
			failed={() => (
				<PageShell actions={actions} persistenceError={persistenceError}>
					<ListLoadError />
				</PageShell>
			)}
		>
			{(unit) => (
				<ModelPage unit={unit} actions={actions} persistenceError={persistenceError} list={binding} />
			)}
		</Unitflow>
	)
}

/**
 * The page chrome, shared by the resolved view and both Unitflow fallbacks so the
 * header never pops in after the body.
 */
function PageShell({
	summary,
	actions,
	persistenceError,
	children,
}: {
	summary?: string
	actions: React.ReactNode
	persistenceError: string | null
	children: React.ReactNode
}) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Dashboards" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Dashboards"
							titleContent={
								summary ? (
									<div className="text-muted-foreground mt-1 font-mono text-[11px]">
										{summary}
									</div>
								) : undefined
							}
						>
							{actions}
						</DashboardLayout.Header>
						{/* Pinned with the header rather than inside Scroll: it explains the
						    disabled buttons above it, so it must not scroll away from them. */}
						{persistenceError && (
							<div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
								<CircleWarningIcon size={14} className="mt-0.5 shrink-0" />
								<span>
									{persistenceError}. Editing, import and delete are disabled until it
									recovers — reading is unaffected.
								</span>
							</div>
						)}
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function ListLoadError() {
	return (
		<SyncUnavailable
			title="Couldn’t load dashboards"
			description="The sync stream dropped and the list couldn’t be read over HTTP either. Your dashboards are safe — this is a read problem."
			onRetry={retryOrgCollections}
		/>
	)
}

const ModelPage = View.make(
	DashboardsListModel,
	({ list }, props: { actions: React.ReactNode; persistenceError: string | null; list: ListBinding }) => {
		if (list.phase === "loading") {
			return (
				<PageShell actions={props.actions} persistenceError={props.persistenceError}>
					<DashboardListSkeleton />
				</PageShell>
			)
		}
		if (list.phase === "error") {
			return (
				<PageShell actions={props.actions} persistenceError={props.persistenceError}>
					<ListLoadError />
				</PageShell>
			)
		}
		return (
			<PageShell
				summary={headerSummary(list.dashboards, formatRelativeTimeOrDate)}
				actions={props.actions}
				persistenceError={props.persistenceError}
			>
				{list.degraded && <SyncDegradedBanner onRetry={retryOrgCollections} />}
				<DashboardList
					dashboards={list.dashboards}
					{...props.list}
					readOnly={props.list.readOnly || list.degraded}
				/>
			</PageShell>
		)
	},
)
