import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { GlobeIcon, ClockIcon, CopyIcon, CheckIcon } from "@/components/icons"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { formatRelativeTime, gradientFor, hostFromUrl } from "./replay-format"
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

export function CopyButton({ value, label }: { value: string; label?: string }) {
	// Silent: the inline check icon is the feedback.
	const { copied, copy } = useCopyToClipboard(label ?? "Value", { silent: true })

	return (
		<button
			type="button"
			onClick={() => copy(value)}
			aria-label={label ?? "Copy"}
			title={copied ? "Copied" : (label ?? "Copy")}
			className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
		>
			{copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
		</button>
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

/** Avatar + label + status + URL/started/id meta row. */
export function SessionIdentityHeader({
	sessionId,
	label,
	urlInitial,
	startTime,
	isActive,
}: {
	sessionId: string
	label: string
	urlInitial: string
	startTime: string
	isActive: boolean
}) {
	const startedEpoch = parseChTimestampMs(startTime)
	const startedValid = Number.isFinite(startedEpoch)
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div
				className={`grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} font-display text-base font-semibold text-white shadow-sm`}
			>
				{(label[0] ?? "?").toUpperCase()}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<h2 className="truncate font-display text-lg font-semibold leading-tight">{label}</h2>
					<StatusPill active={isActive} />
				</div>
				<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<a
						href={urlInitial}
						target="_blank"
						rel="noreferrer"
						title={urlInitial}
						className="inline-flex min-w-0 max-w-md items-center gap-1.5 font-mono hover:text-foreground"
					>
						<GlobeIcon className="size-3 shrink-0 opacity-70" />
						<span className="truncate">{hostFromUrl(urlInitial)}</span>
					</a>
					{startedValid && (
						<>
							<span className="opacity-40">·</span>
							<span
								className="inline-flex shrink-0 items-center gap-1.5"
								title={new Date(startedEpoch).toLocaleString()}
							>
								<ClockIcon className="size-3 shrink-0 opacity-70" />
								{formatRelativeTime(startedEpoch)}
							</span>
						</>
					)}
					<span className="opacity-40">·</span>
					<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">
						{sessionId.slice(0, 12)}
						<CopyButton value={sessionId} label="Copy session id" />
					</span>
				</div>
			</div>
		</div>
	)
}

export function ReplayDetailSkeleton() {
	// Mirrors the studio layout (full-width header, a player | event-stream row,
	// then a full-width trace timeline) so the page doesn't reflow on load.
	return (
		<div className="flex flex-col gap-4">
			{/* Header: identity + vitals strip, then a divided meta line */}
			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex items-center gap-3">
						<Skeleton className="size-11 shrink-0 rounded-full" />
						<div className="space-y-2">
							<Skeleton className="h-4 w-44" />
							<Skeleton className="h-3 w-64" />
						</div>
					</div>
					<Skeleton className="h-10 w-64 shrink-0 rounded-lg" />
				</div>
				<div className="border-t border-border/60 pt-3">
					<Skeleton className="h-4 w-96 max-w-full rounded" />
				</div>
			</div>

			{/* Browser chrome + video | event stream */}
			<div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,64rem)_minmax(20rem,1fr)] lg:items-stretch">
				<Skeleton className="aspect-video w-full rounded-xl" />
				<Skeleton className="h-[clamp(20rem,60vh,28rem)] w-full rounded-xl lg:h-auto" />
			</div>

			{/* Transport bar — full width */}
			<Skeleton className="h-20 w-full rounded-xl" />

			{/* Trace timeline — full width */}
			<Skeleton className="h-56 w-full rounded-xl" />
		</div>
	)
}
