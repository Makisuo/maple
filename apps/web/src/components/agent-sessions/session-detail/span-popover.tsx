import type { ComponentProps } from "react"

import type { AiSessionSpan } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent } from "@maple/ui/components/ui/popover"
import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { CircleXmarkIcon, XmarkIcon } from "@/components/icons"
import { classifyAiSpan, spanFailed, spanModel } from "@/lib/agent-sessions/session-turns"
import type { SessionToolResults } from "@/lib/agent-sessions/span-detail"
import { SpanExpansion, type SpanDetailTab } from "./span-expansion"
import { CATEGORY_ICON, CATEGORY_TEXT } from "./span-visuals"

/** What the popover points at — a row, a node, a cell. A ref is accepted so a
 *  view can name a fallback container it has not rendered yet. */
export type SpanAnchor = ComponentProps<typeof PopoverContent>["anchor"]

/**
 * One span, inspected in place.
 *
 * Every view opens the same panel against whatever the reader clicked: the
 * Overview's findings, the flow's nodes, the waterfall's rows. It replaced
 * three different chromes — a tab switch, a docked drawer and an inline row —
 * that each answered the same question in a different place, and each cost the
 * reader the view they were reading it from.
 *
 * The popover is open exactly when a span is selected AND its anchor is on
 * screen. In the virtualized waterfall the anchor row unmounts when it scrolls
 * far enough away, which closes the panel rather than leaving it pointing at a
 * detached box; the selection stays in the URL, so scrolling back reopens it.
 */
export function SpanPopover({
	span,
	anchor,
	turnOrdinal,
	tab,
	onTabChange,
	toolResults,
	onClose,
	onOpenTraceView,
}: {
	/** The selected span, or `undefined` when nothing is open. */
	span: AiSessionSpan | undefined
	anchor: SpanAnchor
	/** "Turn 3" / "Segment 2" — where the span lives, for the title row. */
	turnOrdinal?: string | undefined
	/** The reader's tab choice, held by SessionViews so it survives switching
	 *  spans and views; `undefined` means none made yet — pick by content. */
	tab: SpanDetailTab | undefined
	onTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id (`sessionToolResults`). */
	toolResults?: SessionToolResults
	/** Clears the selection: Escape, the close button, a press outside. */
	onClose: () => void
	/** Offered only where the reader is not already in the Traces view. */
	onOpenTraceView?: (() => void) | undefined
}) {
	const open = span !== undefined && anchor !== null && anchor !== undefined

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			{span !== undefined && (
				<PopoverContent
					anchor={anchor}
					side="bottom"
					align="start"
					className="w-[min(40rem,calc(100vw-2rem))]"
				>
					{/* The panel's own handle, for the page's tests and for anything
					    that needs to find it inside the portal. It is also the scroll
					    viewport: the height cap must live on the element that scrolls —
					    capping the popup instead leaves the ui viewport sized to
					    `--available-height`, spilling past the popup's border. */}
					<div
						data-slot="span-popover"
						className="-m-4 max-h-[min(32rem,calc(var(--available-height)-2rem))] min-w-0 overflow-y-auto overscroll-contain p-4"
					>
						<SpanExpansion
							key={span.spanId}
							span={span}
							tab={tab}
							onTabChange={onTabChange}
							toolResults={toolResults}
							header={
								<TitleRow
									span={span}
									turnOrdinal={turnOrdinal}
									onClose={onClose}
									onOpenTraceView={onOpenTraceView}
								/>
							}
						/>
					</div>
				</PopoverContent>
			)}
		</Popover>
	)
}

/** Names the span in the same vocabulary the row or node that opened it used,
 *  and stays put while the payload under it scrolls. */
function TitleRow({
	span,
	turnOrdinal,
	onClose,
	onOpenTraceView,
}: {
	span: AiSessionSpan
	turnOrdinal: string | undefined
	onClose: () => void
	onOpenTraceView: (() => void) | undefined
}) {
	const category = classifyAiSpan(span)
	const errored = spanFailed(span)
	const Glyph = errored ? CircleXmarkIcon : CATEGORY_ICON[category]
	const subtitle = [turnOrdinal, spanModel(span), formatDuration(span.durationMs)]
		.filter((part): part is string => part !== undefined)
		.join(" · ")

	return (
		// Pins to the scroller's padding-box top, covering content that would
		// otherwise show through the top padding. A negative top margin would
		// shrink this row's margin box inside the flex column and paint it over
		// the tab strip below — only the horizontal margins are safe to bleed.
		<div
			className={cn(
				"-mx-4 sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1",
				"bg-popover px-4 pb-2",
			)}
		>
			<Glyph
				aria-hidden
				size={13}
				className={cn("shrink-0", errored ? "text-destructive" : CATEGORY_TEXT[category])}
			/>
			<span className="min-w-0 truncate font-medium font-mono text-sm">{span.spanName}</span>
			{subtitle !== "" && <span className="text-muted-foreground text-xs">{subtitle}</span>}
			<div className="ml-auto flex items-center gap-2">
				{onOpenTraceView !== undefined && (
					<Button variant="outline" size="sm" className="h-6.5 text-xs" onClick={onOpenTraceView}>
						Open in Traces view
					</Button>
				)}
				<Button variant="ghost" size="icon-sm" aria-label="Close span detail" onClick={onClose}>
					<XmarkIcon size={14} />
				</Button>
			</div>
		</div>
	)
}
