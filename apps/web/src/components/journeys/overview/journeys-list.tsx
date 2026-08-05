import { useCallback, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { JourneyColumnStrip, JourneyListRow, type JourneyColumnSort, type JourneyRow } from "./journey-row"
import { JourneyPrivacyBanner } from "./journeys-empty-states"

interface JourneysListProps {
	journeys: ReadonlyArray<JourneyRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	hasMore?: boolean
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
	sort?: JourneyColumnSort
}

function ListSentinel({ onReachEnd, loadingMore }: Pick<JourneysListProps, "onReachEnd" | "loadingMore">) {
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

export function JourneysList({
	journeys,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
	sort,
}: JourneysListProps) {
	const [listElement, setListElement] = useState<HTMLDivElement | null>(null)
	const scrollElement = listElement?.closest<HTMLDivElement>('[data-slot="page-scroll-area"]') ?? null
	const virtualizer = useVirtualizer({
		count: journeys.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => 64,
		overscan: 8,
		scrollMargin: listElement?.offsetTop ?? 0,
	})

	// The cost bar is scaled against the most expensive journey currently loaded,
	// so the column reads as a distribution of what's in front of you.
	const maxCost = journeys.reduce((max, journey) => Math.max(max, journey.cost ?? 0), 0)
	// One banner beats a marker on every row; a per-row marker only earns its
	// place when it distinguishes some journeys from others.
	const allRedacted = journeys.length > 0 && journeys.every((journey) => journey.contentRedacted)

	return (
		<div className="@container">
			{allRedacted && <JourneyPrivacyBanner />}

			<JourneyColumnStrip sort={sort} />

			<div
				ref={setListElement}
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const journey = journeys[virtualRow.index]!
					return (
						<div
							key={journey.journeyId}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute top-0 left-0 w-full"
							style={{
								transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
							}}
						>
							<JourneyListRow
								journey={journey}
								maxCost={maxCost}
								showRedactedInMeta={!allRedacted}
							/>
						</div>
					)
				})}
			</div>

			{hasMore && <ListSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="flex flex-wrap items-center justify-center gap-2 py-5.5 text-center font-mono text-sm text-muted-foreground">
					<span>Showing the first {journeys.length.toLocaleString()} journeys.</span>
					<span className="text-primary">Narrow the time range to see the rest</span>
				</p>
			)}

			{loadingMore && (
				<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
					<span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
					Loading more journeys…
				</div>
			)}
		</div>
	)
}

/** Skeleton in the shape of the real table: the column strip is real (it doesn't
 *  depend on the data), the six lanes below it are placeholders. */
export function JourneysListSkeleton({ rows = 8 }: { rows?: number }) {
	return (
		<div className="@container">
			<JourneyColumnStrip />
			{Array.from({ length: rows }).map((_, index) => (
				<div key={index} className="flex h-16 items-center gap-3.5 border-b border-border">
					<div className="w-3.5 shrink-0" />
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-3.5" style={{ width: `${34 + ((index * 13) % 26)}%` }} />
						<Skeleton className="h-3 w-40" />
					</div>
					<div className="hidden w-36.5 shrink-0 @3xl:block">
						<Skeleton className="h-3.5 w-24" />
					</div>
					<div className="hidden w-15 shrink-0 justify-end @2xl:flex">
						<Skeleton className="h-3.5 w-6" />
					</div>
					<div className="hidden w-24 shrink-0 justify-end @xl:flex">
						<Skeleton className="h-3.5 w-12" />
					</div>
					<div className="flex w-19 shrink-0 justify-end">
						<Skeleton className="h-3.5 w-12" />
					</div>
					<div className="flex w-24 shrink-0 justify-end">
						<Skeleton className="h-3.5 w-14" />
					</div>
				</div>
			))}
		</div>
	)
}
