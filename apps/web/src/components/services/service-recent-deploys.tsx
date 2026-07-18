import { useMemo } from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import type { ReleasePoint } from "@/components/vcs/commit-markers/marker-layout"
import { formatNumber } from "@/lib/format"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { formatTimeAgo, SectionCard } from "./section-card"

const RAIL_LIMIT = 6

interface ServiceRecentDeploysProps {
	/** The per-bucket release timeline the Overview already fetched. */
	releases: ReadonlyArray<ReleasePoint>
	/** True while the overview query is still in flight (no retained data yet). */
	isLoading?: boolean
}

interface DeployEntry {
	sha: string
	/** First bucket the commit was seen in — its deploy time, as the data can tell. */
	firstSeen: string
	/** Total spans attributed to the commit across the window. */
	spanCount: number
}

// A 40-hex git sha reads as its 7-char short form; tags/versions stay verbatim.
function shortLabel(sha: string): string {
	return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : sha
}

function deriveDeploys(releases: ReadonlyArray<ReleasePoint>): DeployEntry[] {
	const bySha = new Map<string, DeployEntry>()
	for (const point of releases) {
		const existing = bySha.get(point.commitSha)
		if (existing === undefined) {
			bySha.set(point.commitSha, {
				sha: point.commitSha,
				firstSeen: point.bucket,
				spanCount: point.count,
			})
		} else {
			existing.spanCount += point.count
			if (point.bucket < existing.firstSeen) existing.firstSeen = point.bucket
		}
	}
	return [...bySha.values()].toSorted((a, b) =>
		a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0,
	)
}

/**
 * "Recent deploys" rail: the commits behind the chart's deploy markers, newest
 * first, each one hover-expandable to the resolved commit card. Derived purely
 * from the release timeline the Overview tab already has — no extra fetch.
 */
export function ServiceRecentDeploys({ releases, isLoading = false }: ServiceRecentDeploysProps) {
	const deploys = useMemo(() => deriveDeploys(releases), [releases])
	const visible = deploys.slice(0, RAIL_LIMIT)

	if (isLoading) {
		return (
			<SectionCard title="Recent deploys">
				<div className="space-y-px p-2">
					{Array.from({ length: 4 }).map((_, i) => (
						<Skeleton key={i} className="h-8 w-full" />
					))}
				</div>
			</SectionCard>
		)
	}

	return (
		<SectionCard
			title="Recent deploys"
			action={
				deploys.length > RAIL_LIMIT ? (
					<span className="text-xs text-muted-foreground/70">
						{deploys.length} versions in window
					</span>
				) : undefined
			}
		>
			{visible.length === 0 ? (
				<div className="px-4 py-6 text-center text-xs text-muted-foreground">
					No deploys detected in this window.
				</div>
			) : (
				<div className="space-y-px p-2">
					{visible.map((deploy) => (
						<div
							key={deploy.sha}
							className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm"
						>
							<CommitShaHoverCard sha={deploy.sha} className="font-mono text-xs">
								{shortLabel(deploy.sha)}
							</CommitShaHoverCard>
							<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
								first seen{" "}
								{new Date(normalizeTimestampInput(deploy.firstSeen)).toLocaleString(
									undefined,
									{ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
								)}
							</span>
							<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
								{formatNumber(deploy.spanCount)} spans
							</span>
							<span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
								{formatTimeAgo(deploy.firstSeen)}
							</span>
						</div>
					))}
				</div>
			)}
		</SectionCard>
	)
}
