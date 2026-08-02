import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { GlobeIcon, ClockIcon } from "@/components/icons"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { formatRelativeFrom } from "@maple/ui/time-format"
import { formatSessionDuration, gradientFor, hostFromUrl } from "./replay-format"
import { parseChTimestampMs } from "./replay-timeline"

// Presentational building blocks for the session-replay detail page. Extracted
// from the route so both the real page and the placeholder-data preview render
// the exact same components (no drift between what ships and what we review).

/** One-shot entrance reveal, skipped when the user prefers reduced motion. */
export function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
	const reduceMotion = useReducedMotion()
	if (reduceMotion) return <>{children}</>
	return (
		<motion.div
			initial={{ opacity: 0, y: 8 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.3, delay, ease: "easeOut" }}
		>
			{children}
		</motion.div>
	)
}

function StatusPill({ active }: { active: boolean }) {
	if (!active) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
				<span className="size-1.5 rounded-full bg-muted-foreground/50" />
				Ended
			</span>
		)
	}
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
			<span className="relative flex size-1.5">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
				<span className="relative inline-flex size-1.5 rounded-full bg-success" />
			</span>
			Live
		</span>
	)
}

/**
 * Single-line identity bar for the player-first detail layout: who + where +
 * when on the left, the headline duration and error count on the right. All
 * remaining metadata lives in the rail's Session tab, so this stays one row.
 */
export function SessionIdentityBar({
	sessionId,
	label,
	urlInitial,
	startTime,
	isActive,
	durationMs,
	errorCount,
}: {
	sessionId: string
	label: string
	urlInitial: string
	startTime: string
	isActive: boolean
	durationMs: number | null
	errorCount: number
}) {
	const startedEpoch = parseChTimestampMs(startTime)
	const startedValid = Number.isFinite(startedEpoch)
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<div
					className={`grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} text-xs font-semibold text-white shadow-sm`}
				>
					{(label[0] ?? "?").toUpperCase()}
				</div>
				<h2 className="min-w-0 truncate text-sm font-medium leading-tight">{label}</h2>
				<StatusPill active={isActive} />
				<a
					href={urlInitial}
					target="_blank"
					rel="noreferrer"
					title={urlInitial}
					className="hidden min-w-0 max-w-64 items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground sm:inline-flex"
				>
					<GlobeIcon className="size-3 shrink-0 opacity-70" />
					<span className="truncate">{hostFromUrl(urlInitial)}</span>
				</a>
				{startedValid && (
					<span
						className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:inline-flex"
						title={new Date(startedEpoch).toLocaleString()}
					>
						<ClockIcon className="size-3 shrink-0 opacity-70" />
						started {formatRelativeFrom(startedEpoch)}
					</span>
				)}
				<span className="hidden shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground xl:inline-flex">
					{sessionId.slice(0, 8)}
					<CopyButton value={sessionId} label="Session ID" iconSize={12} className="size-5" toast={false} />
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-3">
				<span className="flex items-baseline gap-1.5">
					<span className="font-mono text-[15px] font-semibold tabular-nums">
						{formatSessionDuration(durationMs)}
					</span>
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						duration
					</span>
				</span>
				{errorCount > 0 && (
					<span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-destructive">
						<span className="size-1 rounded-full bg-destructive" aria-hidden />
						{errorCount} error{errorCount === 1 ? "" : "s"}
					</span>
				)}
			</div>
		</div>
	)
}

export function ReplayDetailSkeleton() {
	// Mirrors the studio layout (identity bar, player + docked transport on the
	// left, the tabbed rail on the right) so the page doesn't reflow on load.
	return (
		<div className="flex flex-col gap-3.5 lg:flex-row">
			<div className="flex min-w-0 flex-1 flex-col gap-3.5">
				<div className="flex items-center gap-3">
					<Skeleton className="size-8 shrink-0 rounded-full" />
					<Skeleton className="h-4 w-44" />
					<Skeleton className="h-4 w-64" />
					<Skeleton className="ml-auto h-4 w-24" />
				</div>
				<Skeleton className="aspect-video w-full rounded-t-xl" />
				<Skeleton className="-mt-3.5 h-14 w-full rounded-b-xl" />
				<Skeleton className="h-48 w-full rounded-xl" />
			</div>
			<Skeleton className="h-72 w-full rounded-xl lg:h-auto lg:w-84 lg:shrink-0" />
		</div>
	)
}
