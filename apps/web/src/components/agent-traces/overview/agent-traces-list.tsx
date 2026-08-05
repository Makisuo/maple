import { useCallback, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { AgentTraceListRow, type AgentTraceRow } from "./agent-trace-row"
import { AgentTracePrivacyBanner } from "./agent-traces-empty-states"

interface AgentTracesListProps {
	agentTraces: ReadonlyArray<AgentTraceRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	hasMore?: boolean
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
}

function ListSentinel({ onReachEnd, loadingMore }: Pick<AgentTracesListProps, "onReachEnd" | "loadingMore">) {
	const elementRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return
			const observer = new IntersectionObserver(
				(entries) => {
					if (entries[0]?.isIntersecting && !loadingMore) onReachEnd?.()
				},
				{ rootMargin: "400px 0px" },
			)
			// React Doctor does not yet recognize React 19 callback-ref cleanup.
			// oxlint-disable-next-line react-doctor/effect-needs-cleanup
			observer.observe(element)
			return () => observer.disconnect()
		},
		[loadingMore, onReachEnd],
	)

	return <div ref={elementRef} aria-hidden className="h-px w-full" />
}

export function AgentTracesList({
	agentTraces,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
}: AgentTracesListProps) {
	const [listElement, setListElement] = useState<HTMLDivElement | null>(null)
	const scrollElement = listElement?.closest<HTMLDivElement>('[data-slot="page-scroll-area"]') ?? null
	const virtualizer = useVirtualizer({
		count: agentTraces.length,
		getScrollElement: () => scrollElement,
		// The row is content-height, like the replay row: `py-2.5` around a
		// `text-sm` title over a `text-xs` meta line. `measureElement` corrects it
		// on mount; this only has to be close enough that the first paint doesn't
		// jump.
		estimateSize: () => 58,
		overscan: 8,
		scrollMargin: listElement?.offsetTop ?? 0,
	})

	// One banner beats a marker on every row; a per-row marker only earns its
	// place when it distinguishes some agent traces from others.
	const allRedacted = agentTraces.length > 0 && agentTraces.every((agentTrace) => agentTrace.contentRedacted)

	return (
		<div className="@container">
			{allRedacted && <AgentTracePrivacyBanner />}

			<div
				ref={setListElement}
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const agentTrace = agentTraces[virtualRow.index]!
					return (
						<div
							key={agentTrace.agentTraceId}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute top-0 left-0 w-full"
							style={{
								transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
							}}
						>
							<AgentTraceListRow agentTrace={agentTrace} showRedactedInMeta={!allRedacted} />
						</div>
					)
				})}
			</div>

			{hasMore && <ListSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="flex flex-wrap items-center justify-center gap-2 py-5.5 text-center font-mono text-sm text-muted-foreground">
					<span>Showing the first {agentTraces.length.toLocaleString()} agentTraces.</span>
					<span className="text-primary">Narrow the time range to see the rest</span>
				</p>
			)}

			{loadingMore && (
				<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
					<span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
					Loading more agent traces…
				</div>
			)}
		</div>
	)
}

/** Skeleton in the shape of the real list: four lanes, same widths, so the first
 *  paint doesn't shift when the rows arrive. */
export function AgentTracesListSkeleton({ rows = 8 }: { rows?: number }) {
	return (
		<div className="@container">
			{Array.from({ length: rows }).map((_, index) => (
				<div
					key={index}
					className="flex items-center gap-3 border-b border-border px-3 py-2.5 @2xl:gap-4"
				>
					<div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
						<Skeleton className="h-3.5" style={{ width: `${34 + ((index * 13) % 26)}%` }} />
						<Skeleton className="h-3 w-56" />
					</div>
					<div className="hidden w-[13.5rem] shrink-0 items-center gap-2 @2xl:flex">
						<Skeleton className="h-3.5 w-12" />
						<Skeleton className="h-3 w-28" />
					</div>
					<div className="flex w-20 shrink-0 justify-end">
						<Skeleton className="h-5 w-14 rounded-full" />
					</div>
					{/* Time lane plus the hover glyph's reserved width — without the
					    spacer the skeleton's right edge sits 32px inboard of the rows. */}
					<div className="flex shrink-0 items-center gap-2">
						<div className="flex w-24 justify-end">
							<Skeleton className="h-3.5 w-14" />
						</div>
						<div className="size-6" />
					</div>
				</div>
			))}
		</div>
	)
}
