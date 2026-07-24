import { useCallback, useMemo } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { AnomaliesFilterSidebar, type AnomalyFilters } from "@/components/anomalies/anomalies-filter-sidebar"
import {
	ANOMALY_GROUP_ORDER,
	AnomalyGroup,
	anomalyGroupKey,
	type AnomalyGroupKey,
} from "@/components/anomalies/anomaly-group"
import { AnomalyLiveIndicator } from "@/components/anomalies/anomaly-live-indicator"
import { IssuesToolbar } from "@/components/errors/issues-toolbar"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { ErrorState } from "@/components/common/error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { AnomalyIncidentDocument, AnomalyIncidentId } from "@maple/domain/http"

const LIVE_REFRESH_INTERVAL_MS = 15_000
const INCIDENTS_PAGE_LIMIT = 500

type StatusTab = "open" | "resolved" | "all"

const TOOLBAR_TABS: ReadonlyArray<{ value: StatusTab; label: string }> = [
	{ value: "open", label: "Open" },
	{ value: "resolved", label: "Resolved" },
	{ value: "all", label: "All" },
]

const searchSchema = Schema.Struct({
	status: Schema.optional(Schema.Literals(["open", "resolved", "all"])),
	severity: Schema.optional(Schema.Array(Schema.Literals(["warning", "critical"]))),
	signals: Schema.optional(
		Schema.Array(
			Schema.Literals(["error_rate", "latency_p95", "throughput", "error_spike", "log_volume"]),
		),
	),
	services: Schema.optional(Schema.Array(Schema.String)),
	envs: Schema.optional(Schema.Array(Schema.String)),
	live: Schema.optional(Schema.Boolean),
})

export const Route = createFileRoute("/anomalies/")({
	component: AnomaliesPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const PAGE_DESCRIPTION =
	"Baseline deviations detected automatically across your services — no rules required."

function AnomaliesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const status: StatusTab = search.status ?? "open"
	const live = search.live ?? status === "open"

	const incidentsQueryAtom = MapleApiAtomClient.query("anomalies", "listIncidents", {
		query: status === "all" ? { limit: INCIDENTS_PAGE_LIMIT } : { status, limit: INCIDENTS_PAGE_LIMIT },
		reactivityKeys: ["anomalyIncidents"],
	})
	// Retain the previous list across tab switches so the page never collapses
	// back to skeletons; live refresh ticks keep the same atom and never dim.
	const incidentsResult = useRetainedRefreshableResultValue(incidentsQueryAtom)
	const refreshIncidents = useAtomRefresh(incidentsQueryAtom)

	useIntervalRefresh(refreshIncidents, {
		intervalMs: LIVE_REFRESH_INTERVAL_MS,
		enabled: live,
	})

	const filters: AnomalyFilters = useMemo(
		() => ({
			severity: search.severity,
			signals: search.signals,
			services: search.services,
			envs: search.envs,
		}),
		[search.severity, search.signals, search.services, search.envs],
	)

	const updateFilter = useCallback(
		<K extends keyof AnomalyFilters>(key: K, value: AnomalyFilters[K]) => {
			navigate({ search: (prev) => ({ ...prev, [key]: value }) })
		},
		[navigate],
	)

	const clearFilters = useCallback(() => {
		navigate({
			search: (prev) => ({
				status: prev.status,
				live: prev.live,
			}),
		})
	}, [navigate])

	const allIncidents = Result.isSuccess(incidentsResult) ? incidentsResult.value.incidents : []

	const filtered = useMemo(
		() =>
			allIncidents.filter(
				(incident) =>
					(filters.severity === undefined || filters.severity.includes(incident.severity)) &&
					(filters.signals === undefined || filters.signals.includes(incident.signalType)) &&
					(filters.services === undefined || filters.services.includes(incident.serviceName)) &&
					(filters.envs === undefined || filters.envs.includes(incident.deploymentEnv)),
			),
		[allIncidents, filters],
	)

	const hasActiveFilters =
		filters.severity !== undefined ||
		filters.signals !== undefined ||
		filters.services !== undefined ||
		filters.envs !== undefined

	const toolbar = (
		<IssuesToolbar
			tabs={TOOLBAR_TABS}
			active={status}
			countNoun={["anomaly", "anomalies"]}
			totalCount={Result.isSuccess(incidentsResult) ? filtered.length : undefined}
			onChange={(value) =>
				navigate({
					search: (prev) => ({
						...prev,
						status: value === "open" ? undefined : value,
					}),
				})
			}
		/>
	)

	const layoutProps = {
		breadcrumbs: [{ label: "Anomalies" }],
		title: "Anomalies",
		description: PAGE_DESCRIPTION,
		headerActions: (
			<AnomalyLiveIndicator
				live={live}
				onToggle={(next) =>
					navigate({
						search: (prev) => ({
							...prev,
							live: next === (status === "open") ? undefined : next,
						}),
					})
				}
			/>
		),
		filterSidebar: (
			<AnomaliesFilterSidebar
				incidents={allIncidents}
				filters={filters}
				onChange={updateFilter}
				onClear={clearFilters}
			/>
		),
	}

	return Result.builder(incidentsResult)
		.onInitial(() => (
			<DashboardLayout {...layoutProps}>
				<div>
					{toolbar}
					<div className="space-y-px p-2">
						{Array.from({ length: 5 }).map((_, i) => (
							<Skeleton key={i} className="h-9 w-full" />
						))}
					</div>
				</div>
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout {...layoutProps}>
				<div>
					{toolbar}
					<div className="p-4">
						<ErrorState
							error={error}
							title="Failed to load anomalies"
							onRetry={refreshIncidents}
						/>
					</div>
				</div>
			</DashboardLayout>
		))
		.onSuccess(() => (
			<AnomaliesPageBody
				incidents={filtered}
				status={status}
				hasActiveFilters={hasActiveFilters}
				onClearFilters={clearFilters}
				toolbar={toolbar}
				layoutProps={layoutProps}
			/>
		))
		.render()
}

function AnomaliesPageBody({
	incidents,
	status,
	hasActiveFilters,
	onClearFilters,
	toolbar,
	layoutProps,
}: {
	incidents: ReadonlyArray<AnomalyIncidentDocument>
	status: StatusTab
	hasActiveFilters: boolean
	onClearFilters: () => void
	toolbar: React.ReactNode
	layoutProps: Omit<React.ComponentProps<typeof DashboardLayout>, "children">
}) {
	const navigate = useNavigate({ from: Route.fullPath })

	const grouped = useMemo(() => {
		const map = new Map<AnomalyGroupKey, AnomalyIncidentDocument[]>()
		for (const incident of incidents) {
			const key = anomalyGroupKey(incident)
			const bucket = map.get(key) ?? []
			bucket.push(incident)
			map.set(key, bucket)
		}
		// Cluster each bucket by service+env so the anomalies one event produces
		// (error-frequency, error-rate, and log-volume changes on one service) sit together;
		// clusters order by their freshest incident, rows within by recency.
		for (const bucket of map.values()) {
			const clusterKey = (i: AnomalyIncidentDocument) => `${i.serviceName}\u0000${i.deploymentEnv}`
			const latestByCluster = new Map<string, string>()
			for (const incident of bucket) {
				const key = clusterKey(incident)
				const latest = latestByCluster.get(key)
				if (latest === undefined || incident.lastTriggeredAt.localeCompare(latest) > 0) {
					latestByCluster.set(key, incident.lastTriggeredAt)
				}
			}
			bucket.sort((a, b) => {
				const clusterA = latestByCluster.get(clusterKey(a))!
				const clusterB = latestByCluster.get(clusterKey(b))!
				if (clusterA !== clusterB) return clusterB.localeCompare(clusterA)
				const keyCompare = clusterKey(a).localeCompare(clusterKey(b))
				if (keyCompare !== 0) return keyCompare
				return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt)
			})
		}
		return map
	}, [incidents])

	const visibleGroups = useMemo(
		() => ANOMALY_GROUP_ORDER.filter((key) => (grouped.get(key)?.length ?? 0) > 0),
		[grouped],
	)

	const flatIds = useMemo(() => {
		const out: string[] = []
		for (const key of visibleGroups) {
			for (const incident of grouped.get(key) ?? []) out.push(incident.id)
		}
		return out
	}, [grouped, visibleGroups])

	const { focusedId, setFocusedId } = useListNavigation({
		ids: flatIds,
		onOpen: (id) => {
			navigate({
				to: "/anomalies/$incidentId",
				params: { incidentId: id as AnomalyIncidentId },
			})
		},
		scrollTo: (id) => scrollIntoView(id),
	})

	return (
		<DashboardLayout {...layoutProps}>
			<div>
				{toolbar}
				{incidents.length === 0 ? (
					<div className="p-4">
						<Empty>
							<EmptyHeader>
								<EmptyTitle>
									{hasActiveFilters
										? "No anomalies match the current filters"
										: status === "open"
											? "No open anomalies"
											: "No anomalies"}
								</EmptyTitle>
								<EmptyDescription>
									{hasActiveFilters
										? "Try widening or clearing the filters."
										: "The detector compares every service's error rate, latency, throughput, error fingerprints, and log volume against its own 7-day baseline. Incidents appear here when something deviates."}
								</EmptyDescription>
							</EmptyHeader>
							{hasActiveFilters ? (
								<Button variant="outline" size="sm" onClick={onClearFilters}>
									Clear filters
								</Button>
							) : null}
						</Empty>
					</div>
				) : (
					<div>
						{visibleGroups.map((key) => (
							<AnomalyGroup
								key={key}
								group={key}
								incidents={grouped.get(key) ?? []}
								focusedId={focusedId}
								onFocus={setFocusedId}
							/>
						))}
					</div>
				)}
			</div>
		</DashboardLayout>
	)
}

function scrollIntoView(incidentId: string) {
	if (typeof document === "undefined") return
	const el = document.querySelector<HTMLElement>(`[data-incident-id="${CSS.escape(incidentId)}"]`)
	if (!el) return
	el.scrollIntoView({ block: "nearest", behavior: "smooth" })
}
