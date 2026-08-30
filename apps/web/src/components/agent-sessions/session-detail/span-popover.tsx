import type { AiSessionSpan } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Dialog, DialogPopup } from "@maple/ui/components/ui/dialog"
import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { CircleXmarkIcon, XmarkIcon } from "@/components/icons"
import { classifyAiSpan, spanFailed, spanModel } from "@/lib/agent-sessions/session-turns"
import type { SessionToolResults } from "@/lib/agent-sessions/span-detail"
import { SpanExpansion, type SpanDetailTab } from "./span-expansion"
import { CATEGORY_ICON, CATEGORY_TEXT } from "./span-visuals"

/**
 * One span, inspected over the whole page.
 *
 * Every view opens the same panel: the Overview's findings, the flow's nodes,
 * the waterfall's rows. It replaced three different chromes — a tab switch, a
 * docked drawer and an inline row — that each answered the same question in a
 * different place, and each cost the reader the view they were reading it from.
 *
 * It is an overlay rather than a popover anchored to what was clicked: a
 * captured prompt is thousands of tokens, and a panel sized to point at a
 * 28px waterfall row made every payload a scroll through a letterbox. The
 * backdrop dims the view underneath instead of hiding it — the reader is still
 * in the session, one Escape from the row they came from.
 *
 * Open exactly when the active view has a span selected (`?span=`), which is
 * also what makes a pasted link open the panel in whichever view it lands in.
 */
export function SpanPopover({
	span,
	turnOrdinal,
	tab,
	onTabChange,
	toolResults,
	onClose,
	onOpenTraceView,
}: {
	/** The selected span, or `undefined` when nothing is open. */
	span: AiSessionSpan | undefined
	/** "Turn 3" / "Segment 2" — where the span lives, for the title row. */
	turnOrdinal?: string | undefined
	/** The reader's tab choice, held by SessionViews so it survives switching
	 *  spans and views; `undefined` means none made yet — pick by content. */
	tab: SpanDetailTab | undefined
	onTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id (`sessionToolResults`). */
	toolResults?: SessionToolResults
	/** Clears the selection: Escape, the close button, a press on the backdrop. */
	onClose: () => void
	/** Offered only where the reader is not already in the Traces view. */
	onOpenTraceView?: (() => void) | undefined
}) {
	return (
		<Dialog
			open={span !== undefined}
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			{span !== undefined && (
				<DialogPopup
					// The chrome is this panel's own — a title row that names the span
					// and carries the way out — so the dialog's corner button would be a
					// second close in the same corner.
					showCloseButton={false}
					bottomStickOnMobile={false}
					className={cn(
						"h-[86vh] w-[86vw] max-w-none",
						"max-sm:h-[calc(100dvh-2rem)] max-sm:w-[calc(100vw-2rem)]",
					)}
				>
					{/* The panel's own handle, for the page's tests and for anything that
					    needs to find it inside the portal. */}
					<div data-slot="span-popover" className="flex min-h-0 min-w-0 grow flex-col">
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
				</DialogPopup>
			)}
		</Dialog>
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
		<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4 pb-3">
			<Glyph
				aria-hidden
				size={14}
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
