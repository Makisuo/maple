import * as React from "react"

import {
	ServiceSpectrumBar,
	computeServiceShares,
} from "@maple/ui/components/traces/service-spectrum-bar"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { formatDuration } from "@/lib/format"
import { cn } from "@maple/ui/utils"
import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import { TraceIdBadge } from "@/components/traces/trace-id-badge"
import type { Span } from "@/api/warehouse/traces"

interface TraceAnatomyStripProps {
	spans: ReadonlyArray<Span>
	totalDurationMs: number
	traceId: string
	hasError: boolean
	httpStatusCode?: number | null
	deploymentEnv?: string
	commitSha?: string
}

function httpStatusColor(code: number): string {
	if (code >= 500) return "text-severity-error"
	if (code >= 400) return "text-severity-warn"
	if (code >= 300) return "text-chart-p50"
	return "text-severity-info"
}

/**
 * The trace's vital signs: total duration as the dominant figure, a segmented
 * per-service share of wall-clock time ("where did the time go"), and the
 * remaining trace metadata as one quiet utility row.
 */
export function TraceAnatomyStrip({
	spans,
	totalDurationMs,
	traceId,
	hasError,
	httpStatusCode,
	deploymentEnv,
	commitSha,
}: TraceAnatomyStripProps) {
	const shares = React.useMemo(() => computeServiceShares(spans), [spans])

	return (
		<div className="shrink-0 space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
				<div className="flex min-w-0 items-baseline gap-3">
					<span className="font-mono text-2xl font-semibold tabular-nums tracking-tight">
						{formatDuration(totalDurationMs)}
					</span>
					<span className="text-xs text-muted-foreground">
						{spans.length} span{spans.length !== 1 ? "s" : ""} · {shares.length} service
						{shares.length !== 1 ? "s" : ""}
					</span>
				</div>

				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
					<span
						className={cn(
							"flex items-center gap-1.5 font-medium",
							hasError ? "text-severity-error" : "text-severity-info",
						)}
					>
						<span aria-hidden className="size-1.5 rounded-full bg-current" />
						{hasError ? "Error" : "OK"}
					</span>

					{httpStatusCode != null && (
						<span className={cn("font-mono font-medium", httpStatusColor(httpStatusCode))}>
							HTTP {httpStatusCode}
						</span>
					)}

					{deploymentEnv && (
						<span
							className={
								deploymentEnv === "production" ? "text-severity-warn" : "text-chart-p50"
							}
						>
							{deploymentEnv}
						</span>
					)}

					{commitSha && (
						<CommitShaHoverCard
							sha={commitSha}
							copy={{ value: commitSha, label: "commit SHA" }}
							className="font-mono text-xs text-muted-foreground hover:text-foreground"
						>
							{commitSha.slice(0, 7)}
						</CommitShaHoverCard>
					)}

					<TraceIdBadge traceId={traceId} size="default" className="text-xs max-w-[10rem]" />
				</div>
			</div>

			<ServiceSpectrumBar shares={shares} />

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{shares.map((share) => (
					<span key={share.serviceName} className="flex items-center gap-1.5 font-mono text-xs">
						<ServiceDot serviceName={share.serviceName} className="size-1.5" />
						<span>{share.serviceName}</span>
						<span className="text-[10px] text-muted-foreground tabular-nums">
							{share.percent.toFixed(share.percent < 10 ? 1 : 0)}%
						</span>
					</span>
				))}
			</div>
		</div>
	)
}
