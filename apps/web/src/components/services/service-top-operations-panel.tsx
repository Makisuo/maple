import { useMemo, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "@maple/ui/lib/utils"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import {
	getServiceEndpointsResultAtom,
	getServiceOperationsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { LatencyValue } from "@maple/ui/components/latency-value"
import type { ServiceOperation } from "@/api/warehouse/service-operations"
import { SectionCard } from "./section-card"
import { callsPerSecond, serviceOperationsQueryInput, windowSeconds } from "./service-operations"
import { endpointDetailSearch, serviceEndpointsQueryInput } from "./service-endpoints"
import { MethodBadge, RouteLabel } from "./service-endpoints-tab"

const PANEL_LIMIT = 5

interface ServiceTopPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Switches the page to the corresponding tab (URL-driven). */
	onViewAll: () => void
}

function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

function formatErrorRate(rate: number): string {
	if (rate >= 0.01) return `${(rate * 100).toFixed(1)}%`
	if (rate > 0) return "<1%"
	return "0%"
}

/**
 * One row of the digest, reduced to what the panel actually renders. Both the
 * operation and endpoint shapes narrow to this, so the two variants below share
 * a single presentation instead of a second copy of the row markup.
 */
interface TopSpanRow {
	key: string
	label: ReactNode
	title: string
	estimatedSpanCount: number
	spanCount: number
	errorRate: number
	p95DurationMs: number
	sparkline: ReadonlyArray<{ count: number }>
	onSelect: () => void
}

/**
 * "Top operations" digest on the Overview tab: the service's busiest span names
 * with rate/error/p95 at a glance. Reads the same atom key the Operations tab
 * fetches, so opening that tab afterwards is a cache hit. Quiet by design —
 * renders nothing while loading or when the service has no operations.
 */
export function ServiceTopOperationsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	onViewAll,
}: ServiceTopPanelProps) {
	const result = useRetainedRefreshableResultValue(
		getServiceOperationsResultAtom({
			data: serviceOperationsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const rows = useMemo<TopSpanRow[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) =>
					r.operations.slice(0, PANEL_LIMIT).map(
						(op: ServiceOperation): TopSpanRow => ({
							key: op.spanName,
							label: (
								<span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
									{op.spanName}
								</span>
							),
							title: `${op.spanName} — see Operations tab`,
							estimatedSpanCount: op.estimatedSpanCount,
							spanCount: op.spanCount,
							errorRate: op.errorRate,
							p95DurationMs: op.p95DurationMs,
							sparkline: op.sparkline,
							onSelect: onViewAll,
						}),
					),
				)
				.orElse(() => []),
		[result, onViewAll],
	)

	return (
		<TopSpansPanel
			title="Top operations"
			rows={rows}
			waiting={Result.isSuccess(result) && result.waiting}
			effectiveStartTime={effectiveStartTime}
			effectiveEndTime={effectiveEndTime}
			onViewAll={onViewAll}
		/>
	)
}

interface ServiceTopEndpointsPanelProps extends ServiceTopPanelProps {
	/** Raw search params, forwarded to the detail route so relative presets stay live. */
	startTime?: string
	endTime?: string
	timePreset?: string
}

/**
 * The Endpoints variant, shown on Overview in place of Top operations when the
 * service is detected as an HTTP API. Reads the same atom key the Endpoints tab
 * uses, and rows drill straight into the endpoint detail route rather than only
 * switching tabs — an endpoint is a place you can go, an operation isn't.
 */
export function ServiceTopEndpointsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	startTime,
	endTime,
	timePreset,
	onViewAll,
}: ServiceTopEndpointsPanelProps) {
	const navigate = useNavigate()
	const result = useRetainedRefreshableResultValue(
		getServiceEndpointsResultAtom({
			data: serviceEndpointsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const rows = useMemo<TopSpanRow[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) =>
					r.endpoints.slice(0, PANEL_LIMIT).map(
						(endpoint): TopSpanRow => ({
							key: endpoint.spanName,
							label: (
								<span className="flex min-w-0 flex-1 items-center gap-2">
									<MethodBadge method={endpoint.method} />
									<RouteLabel route={endpoint.route} className="text-[12.5px]" />
								</span>
							),
							title: `${endpoint.spanName} — open endpoint`,
							estimatedSpanCount: endpoint.estimatedSpanCount,
							spanCount: endpoint.spanCount,
							errorRate: endpoint.errorRate,
							p95DurationMs: endpoint.p95DurationMs,
							sparkline: endpoint.sparkline,
							onSelect: () =>
								navigate({
									to: "/services/$serviceName/endpoints",
									params: { serviceName },
									search: endpointDetailSearch({
										method: endpoint.method,
										route: endpoint.route,
										environments,
										startTime,
										endTime,
										timePreset,
									}),
								}),
						}),
					),
				)
				.orElse(() => []),
		[result, navigate, serviceName, environments, startTime, endTime, timePreset],
	)

	return (
		<TopSpansPanel
			title="Top endpoints"
			rows={rows}
			waiting={Result.isSuccess(result) && result.waiting}
			effectiveStartTime={effectiveStartTime}
			effectiveEndTime={effectiveEndTime}
			onViewAll={onViewAll}
		/>
	)
}

interface TopSpansPanelProps {
	title: string
	rows: ReadonlyArray<TopSpanRow>
	waiting: boolean
	effectiveStartTime: string
	effectiveEndTime: string
	onViewAll: () => void
}

function TopSpansPanel({
	title,
	rows,
	waiting,
	effectiveStartTime,
	effectiveEndTime,
	onViewAll,
}: TopSpansPanelProps) {
	if (rows.length === 0) return null

	const seconds = windowSeconds(effectiveStartTime, effectiveEndTime)
	const maxCalls = rows.reduce((acc, row) => Math.max(acc, row.estimatedSpanCount), 0)

	return (
		<SectionCard
			title={title}
			className={cn("transition-opacity", waiting && "opacity-60")}
			action={
				<button
					type="button"
					onClick={onViewAll}
					className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					View all →
				</button>
			}
		>
			<ul className="divide-y">
				{rows.map((row) => {
					const barPct = maxCalls > 0 ? Math.min((row.estimatedSpanCount / maxCalls) * 100, 100) : 0
					return (
						<li key={row.key}>
							<button
								type="button"
								onClick={row.onSelect}
								className="relative flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
								title={row.title}
							>
								<div
									aria-hidden
									className="pointer-events-none absolute inset-y-1.5 left-2 rounded-sm bg-severity-info/10"
									style={{ width: `calc(${barPct}% - 0.5rem)` }}
								/>
								<span className="relative flex min-w-0 flex-1 items-center">{row.label}</span>
								<span className="relative flex shrink-0 items-center gap-3 font-mono text-[11.5px] tabular-nums">
									<span className="text-foreground">
										{row.estimatedSpanCount > row.spanCount ? "~" : ""}
										{formatRate(callsPerSecond(row.estimatedSpanCount, seconds))}/s
									</span>
									<span
										className={cn(
											row.errorRate > 0.05
												? "text-severity-error"
												: row.errorRate > 0.01
													? "text-severity-warn"
													: "text-muted-foreground/70",
										)}
									>
										{formatErrorRate(row.errorRate)}
									</span>
									<LatencyValue ms={row.p95DurationMs} scale="p95" />
								</span>
								<Sparkline
									data={row.sparkline.map((point) => ({ value: point.count }))}
									className="relative hidden h-5 w-[88px] shrink-0 sm:block"
								/>
							</button>
						</li>
					)
				})}
			</ul>
		</SectionCard>
	)
}
