import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import {
	getServiceHealthBaselineResultAtom,
	getServiceOverviewResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { QueryErrorState } from "@/components/common/query-error-state"
import { AlertFiringHero } from "@/components/alerts/alert-stat-card"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import { ArrowRightIcon } from "@/components/icons"
import type { ServiceHealthBaselineResult, ServiceOverview } from "@/api/warehouse/services"
import type { AlertIncidentDocument } from "@maple/domain/http"

import { Card } from "@maple/ui/components/ui/card"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatErrorRate, formatLatency } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/utils"

import {
	baselineKey,
	buildBaselineMap,
	deriveServiceHealth,
	errorRateTone,
	healthRank,
	incidentMatchesService,
	latencyTone,
	type LatencyBaselineSignal,
	type ServiceHealth,
} from "./service-health"

const MAX_ROWS = 7

interface ServiceHealthProps {
	startTime?: string
	endTime?: string
	timePreset?: string
	environments?: string[]
	/**
	 * Whether the overview/baseline fetches may fire — mirrors the index route's
	 * gate. True once facets resolve, or earlier when a persisted facets hint lets
	 * the dashboard fetch optimistically.
	 */
	canFetch: boolean
}

/** Search params that carry the dashboard's current slice over to `/services`. */
function servicesLinkSearch({
	startTime,
	endTime,
	timePreset,
	environments,
	health,
}: ServiceHealthProps & { health?: ServiceHealth }) {
	return { startTime, endTime, timePreset, environments, health }
}

/**
 * Time-range slice shared by every per-service detail link. The clicked row's
 * environment is appended at the {@link ServiceHealthRow} link site so the
 * detail page scopes its charts to that environment; `health` is not carried —
 * narrower than {@link servicesLinkSearch}.
 */
function serviceDetailSearch({ startTime, endTime, timePreset }: ServiceHealthProps) {
	return { startTime, endTime, timePreset }
}

interface EnrichedService {
	service: ServiceOverview
	health: ServiceHealth
	hasOpenIncident: boolean
	baseline?: LatencyBaselineSignal
}

const HEALTH_DOT_COLOR: Record<ServiceHealth, string> = {
	healthy: "var(--severity-info)",
	degraded: "var(--severity-warn)",
	unhealthy: "var(--severity-error)",
}

/**
 * Shared data layer for both halves of the dashboard's service-health feature.
 * The overview/alerts atoms are keyed by their params (or module-level), so
 * subscribing from two components dedupes to a single fetch each.
 */
function useServiceHealthData({ startTime, endTime, environments, canFetch }: ServiceHealthProps) {
	const overviewResult = useRetainedRefreshableResultValue(
		canFetch
			? getServiceOverviewResultAtom({ data: { startTime, endTime, environments } })
			: disabledResultAtom<{ data: ServiceOverview[] }, unknown>(),
	)

	// Trailing-7d latency baseline behind the baseline-relative health badges.
	// Failure or loading degrades to absolute thresholds — never blocks render.
	const baselineResult = useAtomValue(
		canFetch
			? getServiceHealthBaselineResultAtom({ data: { rangeStartTime: startTime, environments } })
			: disabledResultAtom<ServiceHealthBaselineResult, unknown>(),
	)
	const baselineMap = useMemo(
		() =>
			Result.builder(baselineResult)
				.onSuccess((response) => buildBaselineMap(response.data))
				.orElse(() => new Map<string, LatencyBaselineSignal>()),
		[baselineResult],
	)

	const { result: incidentsResult } = useAlertIncidentsList()
	const { result: rulesResult } = useAlertRulesList()

	const openIncidents = useMemo(
		() =>
			Result.builder(incidentsResult)
				.onSuccess((response) => response.incidents.filter((incident) => incident.status === "open"))
				.orElse(() => []),
		[incidentsResult],
	)

	const rules = useMemo(
		() =>
			Result.builder(rulesResult)
				.onSuccess((response) => [...response.rules])
				.orElse(() => []),
		[rulesResult],
	)

	return { overviewResult, baselineMap, openIncidents, rules }
}

function enrichServices(
	services: readonly ServiceOverview[],
	openIncidents: ReadonlyArray<AlertIncidentDocument>,
	baselineMap: ReadonlyMap<string, LatencyBaselineSignal>,
): EnrichedService[] {
	return services
		.map((service) => {
			const hasOpenIncident = openIncidents.some((incident) =>
				incidentMatchesService(incident, service.serviceName),
			)
			const baseline = baselineMap.get(
				baselineKey(service.serviceName, service.serviceNamespace, service.environment),
			)
			return {
				service,
				hasOpenIncident,
				baseline,
				health: deriveServiceHealth({ ...service, baseline }, hasOpenIncident),
			}
		})
		.sort(
			(a, b) =>
				healthRank(b.health) - healthRank(a.health) || b.service.errorRate - a.service.errorRate,
		)
}

function countByHealth(services: readonly EnrichedService[]): Record<ServiceHealth, number> {
	return services.reduce(
		(acc, { health }) => {
			acc[health] += 1
			return acc
		},
		{ healthy: 0, degraded: 0, unhealthy: 0 } as Record<ServiceHealth, number>,
	)
}

/* -------------------------------------------------------------------------- */
/*  Overview — alerts banner + health summary rail (sits above the cards)     */
/* -------------------------------------------------------------------------- */

export function ServiceHealthOverview(props: ServiceHealthProps) {
	const { overviewResult, baselineMap, openIncidents, rules } = useServiceHealthData(props)

	const criticalCount = openIncidents.filter((incident) => incident.severity === "critical").length
	const warningCount = openIncidents.filter((incident) => incident.severity === "warning").length
	const rulesEnabled = rules.filter((rule) => rule.enabled).length

	// Arrow that jumps to the Services page, optionally pre-filtered to a health
	// bucket. Carries the current time range + environment so the destination
	// shows the same slice the rail counted.
	const railAction = (health?: ServiceHealth) => (
		<Link
			to="/services"
			search={servicesLinkSearch({ ...props, health })}
			aria-label={health ? `View ${health} services` : "View all services"}
			className="text-muted-foreground/40 transition-colors hover:text-foreground"
		>
			<ArrowRightIcon className="size-3" />
		</Link>
	)

	const banner = (
		<AlertFiringHero
			openCount={openIncidents.length}
			criticalCount={criticalCount}
			warningCount={warningCount}
			rulesEnabled={rulesEnabled}
			rulesTotal={rules.length}
		/>
	)

	return Result.builder(overviewResult)
		.onInitial(() => (
			<section className="mb-4 space-y-3">
				{banner}
				<StatRailLoading />
			</section>
		))
		.onError(() => <section className="mb-4 space-y-3">{banner}</section>)
		.onSuccess((response, result) => {
			const counts = countByHealth(enrichServices(response.data, openIncidents, baselineMap))
			return (
				<section className={cn("mb-4 space-y-3", result.waiting && "opacity-60 transition-opacity")}>
					{banner}
					<StatRail>
						<StatRailItem
							eyebrow="Services"
							value={String(response.data.length)}
							action={railAction()}
							delay={0}
						/>
						<StatRailItem
							eyebrow="Healthy"
							value={String(counts.healthy)}
							tone={counts.healthy > 0 ? "ok" : "neutral"}
							action={railAction("healthy")}
							delay={60}
						/>
						<StatRailItem
							eyebrow="Degraded"
							value={String(counts.degraded)}
							tone={counts.degraded > 0 ? "warn" : "neutral"}
							action={railAction("degraded")}
							delay={120}
						/>
						<StatRailItem
							eyebrow="Unhealthy"
							value={String(counts.unhealthy)}
							tone={counts.unhealthy > 0 ? "crit" : "neutral"}
							action={railAction("unhealthy")}
							delay={180}
						/>
					</StatRail>
				</section>
			)
		})
		.render()
}

/* -------------------------------------------------------------------------- */
/*  Breakdown — per-service rows (sits at the bottom, below everything)       */
/* -------------------------------------------------------------------------- */

export function ServiceHealthList(props: ServiceHealthProps) {
	const { overviewResult, baselineMap, openIncidents } = useServiceHealthData(props)

	const header = (
		<div className="flex items-center justify-between">
			<h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Services</h2>
			<Link
				to="/services"
				search={servicesLinkSearch(props)}
				className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				View all services →
			</Link>
		</div>
	)

	return Result.builder(overviewResult)
		.onInitial(() => (
			<section className="mt-4 space-y-3">
				{header}
				<Card className="overflow-hidden p-0">
					<div className="space-y-2 p-4">
						{Array.from({ length: 4 }).map((_, i) => (
							<Skeleton key={i} className="h-6 w-full" />
						))}
					</div>
				</Card>
			</section>
		))
		.onError((error) => (
			<section className="mt-4 space-y-3">
				{header}
				<QueryErrorState error={error} />
			</section>
		))
		.onSuccess((response, result) => {
			const rows = enrichServices(response.data, openIncidents, baselineMap).slice(0, MAX_ROWS)
			return (
				<section className={cn("mt-4 space-y-3", result.waiting && "opacity-60 transition-opacity")}>
					{header}
					<Card className="overflow-hidden p-0">
						{rows.length === 0 ? (
							<div className="px-4 py-8 text-center text-sm text-muted-foreground">
								No services reporting in this window.
							</div>
						) : (
							<ul className="divide-y divide-border">
								{rows.map(({ service, health, hasOpenIncident, baseline }) => (
									<ServiceHealthRow
										key={`${service.serviceName}:${service.serviceNamespace}:${service.environment}`}
										service={service}
										health={health}
										hasOpenIncident={hasOpenIncident}
										baseline={baseline}
										detailSearch={serviceDetailSearch(props)}
									/>
								))}
							</ul>
						)}
					</Card>
				</section>
			)
		})
		.render()
}

function ServiceHealthRow({
	service,
	health,
	hasOpenIncident,
	baseline,
	detailSearch,
}: EnrichedService & { detailSearch: ReturnType<typeof serviceDetailSearch> }) {
	return (
		<li>
			<Link
				to="/services/$serviceName"
				params={{ serviceName: service.serviceName }}
				search={{ ...detailSearch, environments: [service.environment] }}
				className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
			>
				<span
					aria-hidden
					className="size-2 shrink-0 rounded-full"
					style={{ backgroundColor: HEALTH_DOT_COLOR[health] }}
				/>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate text-sm font-medium text-foreground">
						{service.serviceName}
					</span>
					<span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
						{service.environment}
					</span>
					{hasOpenIncident && (
						<Badge variant="error" size="sm" className="shrink-0">
							Alerting
						</Badge>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-5 font-mono text-xs tabular-nums">
					<Metric
						label="err"
						value={formatErrorRate(service.errorRate)}
						tone={errorRateTone(service.errorRate)}
					/>
					<Metric
						label="p95"
						value={formatLatency(service.p95LatencyMs)}
						tone={latencyTone(service.p95LatencyMs, service.spanCount, baseline)}
					/>
					<Metric
						label="rps"
						value={`${service.hasSampling ? "~" : ""}${formatThroughput(service.throughput)}`}
					/>
				</div>
			</Link>
		</li>
	)
}

function Metric({
	label,
	value,
	tone = "ok",
}: {
	label: string
	value: string
	tone?: "ok" | "warn" | "crit"
}) {
	const toneClass =
		tone === "crit"
			? "text-[var(--severity-error)]"
			: tone === "warn"
				? "text-[var(--severity-warn)]"
				: "text-foreground"
	return (
		<div className="flex w-16 flex-col items-end gap-0.5">
			<span className={cn("leading-none", toneClass)}>{value}</span>
			<span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
		</div>
	)
}

function formatThroughput(rps: number): string {
	if (!Number.isFinite(rps)) return "—"
	if (rps >= 100) return `${Math.round(rps)}/s`
	if (rps >= 1) return `${rps.toFixed(1)}/s`
	return `${rps.toFixed(2)}/s`
}
