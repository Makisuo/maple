import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { SeverityBadge } from "@/components/errors/severity-badge"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { buildServiceOpenIssuesQuery, errorIssueFromV2 } from "@/lib/services/error-issues"
import { formatNumber } from "@/lib/format"
import { formatTimeAgo, SectionCard } from "./section-card"

interface ServiceErrorsPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	/** Page-level env filter (single-element by convention, see the route). */
	environments?: string[]
}

function PanelFrame({ children }: { children: React.ReactNode }) {
	return (
		<SectionCard
			title="Open issues"
			action={
				<Link to="/errors/issues" className="text-xs text-primary hover:underline">
					View all →
				</Link>
			}
		>
			{children}
		</SectionCard>
	)
}

function PanelSkeleton() {
	return (
		<PanelFrame>
			<div className="space-y-px p-2">
				{Array.from({ length: 4 }).map((_, i) => (
					<Skeleton key={i} className="h-8 w-full" />
				))}
			</div>
		</PanelFrame>
	)
}

function PanelMessage({ children }: { children: React.ReactNode }) {
	return <div className="px-4 py-6 text-center text-xs text-muted-foreground">{children}</div>
}

function IssueLine({ issue }: { issue: ErrorIssueDocument }) {
	const title = issue.errorLabel || issue.exceptionType || issue.exceptionMessage || "Unknown error"
	return (
		<Link
			to="/errors/issues/$issueId"
			params={{ issueId: issue.id }}
			className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<SeverityBadge severity={issue.severity} className="w-[60px] shrink-0 justify-center" />
			<span className="min-w-0 flex-1 truncate" title={title}>
				{title}
			</span>
			<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
				{formatNumber(issue.occurrenceCount)}×
			</span>
			<span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
				{formatTimeAgo(issue.lastSeenAt)}
			</span>
		</Link>
	)
}

function PanelReady({ issues }: { issues: ReadonlyArray<ErrorIssueDocument> }) {
	return (
		<PanelFrame>
			{issues.length === 0 ? (
				<PanelMessage>No open issues for this service.</PanelMessage>
			) : (
				<div className="space-y-px p-2">
					{issues.map((issue) => (
						<IssueLine key={issue.id} issue={issue} />
					))}
				</div>
			)}
		</PanelFrame>
	)
}

export function ServiceErrorsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
}: ServiceErrorsPanelProps) {
	// Only a single selected environment scopes the list (matching the switcher's
	// single-select semantics); the page window rides along so the filter means
	// "issues seen in this environment in this window".
	const environment = environments?.length === 1 ? environments[0] : undefined
	const result = useAtomValue(
		MapleApiV2AtomClient.query("errorIssues", "list", {
			query: buildServiceOpenIssuesQuery(
				serviceName,
				environment === undefined
					? undefined
					: { environment, startTime: effectiveStartTime, endTime: effectiveEndTime },
			),
			reactivityKeys: ["errorIssues"],
		}),
	)
	if (Result.isInitial(result)) return <PanelSkeleton />
	if (Result.isFailure(result)) {
		return (
			<PanelFrame>
				<PanelMessage>Issues could not be loaded.</PanelMessage>
			</PanelFrame>
		)
	}
	return <PanelReady issues={result.value.data.map(errorIssueFromV2)} />
}
