import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Button } from "../ui/button"
import { SpanRow } from "./span-row"
import { useTraceView } from "./trace-view-context"
import { collectAllCollapsibleIds, collectAncestorIds, computeDefaultExpandedSpanIds } from "./auto-collapse"
import type { SpanNode } from "../../lib/types"

// Estimated row height; the virtualizer self-corrects via measureElement.
const ROW_HEIGHT = 33

/** Flatten the tree into the ordered list of rows currently visible (i.e. every
 *  ancestor is expanded). `node.depth` already carries the indentation level. */
function flattenVisible(nodes: SpanNode[], expanded: Set<string>, out: SpanNode[] = []): SpanNode[] {
	for (const node of nodes) {
		out.push(node)
		if (expanded.has(node.spanId) && node.children.length > 0) {
			flattenVisible(node.children, expanded, out)
		}
	}
	return out
}

export function SpanHierarchy() {
	const { rootSpans, totalDurationMs, traceStartTime, selectedSpanId, onSelectSpan } = useTraceView()

	const [expandedSpans, setExpandedSpans] = React.useState<Set<string>>(() => {
		return computeDefaultExpandedSpanIds(rootSpans, { keepVisibleSpanId: selectedSpanId })
	})

	// Reveal a span selected after mount — a deep link from the traces list, or a
	// pick in another tab — by merging its ancestor chain into the expanded set.
	// Union rather than recompute, so the user's own toggles survive. Adjusting
	// state during render (rather than in an effect) keeps the row laid out before
	// the scroll effect below runs.
	const [lastSelectedSpanId, setLastSelectedSpanId] = React.useState(selectedSpanId)
	if (selectedSpanId !== lastSelectedSpanId) {
		setLastSelectedSpanId(selectedSpanId)
		if (selectedSpanId) {
			const ancestors = collectAncestorIds(rootSpans, selectedSpanId)
			if (ancestors.size > 0) {
				setExpandedSpans((prev) => {
					let next: Set<string> | null = null
					for (const id of ancestors) {
						if (!prev.has(id)) (next ??= new Set(prev)).add(id)
					}
					return next ?? prev
				})
			}
		}
	}

	const toggleSpan = React.useCallback((span: SpanNode) => {
		setExpandedSpans((prev) => {
			const next = new Set(prev)
			if (next.has(span.spanId)) {
				next.delete(span.spanId)
			} else {
				next.add(span.spanId)
			}
			return next
		})
	}, [])

	const flat = React.useMemo(() => flattenVisible(rootSpans, expandedSpans), [rootSpans, expandedSpans])

	const scrollRef = React.useRef<HTMLDivElement>(null)

	const virtualizer = useVirtualizer({
		count: flat.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		getItemKey: (index) => flat[index].spanId,
		overscan: 12,
	})

	// Bring the selected span on screen — virtualized rows are absent from the DOM,
	// so scrolling has to go through the virtualizer.
	//
	// On a deep link the first attempt lands before the scroll container (inside a
	// resizable panel) has been laid out, and `scrollToIndex` against a zero-height
	// viewport is a no-op. So retry across a few frames and only latch the ref once
	// the row is genuinely inside the visible window — a single shot silently loses
	// the scroll on exactly the case this exists for.
	const scrolledToRef = React.useRef<string | undefined>(undefined)
	React.useEffect(() => {
		if (!selectedSpanId || selectedSpanId === scrolledToRef.current) return
		const index = flat.findIndex((node) => node.spanId === selectedSpanId)
		if (index === -1) return

		// `virtualizer.scrollToIndex` is deliberately unused: inside the resizable
		// panel its internal viewport rect reads as the full content height, so it
		// decides every row is already visible and scrolls nowhere. The virtual item's
		// `start`/`end` are trustworthy though — they are what positions the row — so
		// scroll the container to them directly.
		//
		// Re-assert across frames instead of scrolling once: on a deep link the panel
		// and the row heights settle over the first few frames, and mount layout wipes
		// an early scrollTop. The latch is therefore only taken after a *later* frame
		// observes the row actually in view, never right after writing scrollTop.
		let attempts = 0
		let handle = 0
		const attempt = () => {
			const scroller = scrollRef.current
			if (scroller?.clientHeight) {
				const row = virtualizer.getVirtualItems().find((item) => item.index === index)
				const start = row?.start ?? index * ROW_HEIGHT
				const end = row?.end ?? start + ROW_HEIGHT
				const viewTop = scroller.scrollTop
				const viewBottom = viewTop + scroller.clientHeight

				// A row already sitting comfortably inside the window is left alone —
				// selecting a visible span must not yank the list around.
				const comfortablyVisible = start >= viewTop + ROW_HEIGHT && end <= viewBottom - ROW_HEIGHT
				if (row && comfortablyVisible) {
					scrolledToRef.current = selectedSpanId
					return
				}

				// Otherwise centre it: flush-to-edge alignment loses the row again when
				// the estimated row heights are replaced by measured ones a frame later.
				const target = Math.max(
					0,
					Math.min(
						start - (scroller.clientHeight - (end - start)) / 2,
						scroller.scrollHeight - scroller.clientHeight,
					),
				)
				if (Math.abs(viewTop - target) <= 1) {
					if (row) {
						scrolledToRef.current = selectedSpanId
						return
					}
				} else {
					scroller.scrollTop = target
				}
			}
			if (++attempts < 15) handle = requestAnimationFrame(attempt)
		}
		attempt()
		return () => cancelAnimationFrame(handle)
	}, [selectedSpanId, flat, virtualizer])

	if (rootSpans.length === 0) {
		return (
			<div className="rounded-md border p-8 text-center">
				<p className="text-muted-foreground">No spans found for this trace</p>
			</div>
		)
	}

	const virtualItems = virtualizer.getVirtualItems()

	return (
		<div className="flex h-full flex-col overflow-hidden rounded-md border">
			{/* @container/row must match SpanRow's, so header and rows drop the Duration bar together */}
			<div className="@container/row flex shrink-0 items-center border-b bg-muted/30 px-2 py-1.5 text-xs font-medium text-muted-foreground">
				{/* Left section header */}
				<div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
					<div className="flex items-center gap-0.5">
						<Button
							variant="ghost"
							size="sm"
							className="h-5 px-1.5 text-[10px]"
							onClick={() => setExpandedSpans(collectAllCollapsibleIds(rootSpans))}
						>
							Expand<span className="hidden @min-[480px]/row:inline">&nbsp;all</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-5 px-1.5 text-[10px]"
							onClick={() => setExpandedSpans(new Set())}
						>
							Collapse<span className="hidden @min-[480px]/row:inline">&nbsp;all</span>
						</Button>
					</div>
				</div>
				{/* Right section header (fixed widths matching rows) */}
				<div className="flex items-center gap-2 shrink-0 ml-2">
					<span className="hidden w-48 text-center @min-[560px]/row:block">Duration</span>
					<span className="w-16 text-right">Time</span>
					<span className="w-14 text-center">Status</span>
				</div>
			</div>

			<div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
				<div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
					{virtualItems.map((virtualRow) => {
						const node = flat[virtualRow.index]
						return (
							<div
								key={node.spanId}
								ref={virtualizer.measureElement}
								data-index={virtualRow.index}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${virtualRow.start}px)`,
								}}
							>
								<SpanRow
									span={node}
									totalDurationMs={totalDurationMs}
									traceStartTime={traceStartTime}
									expanded={expandedSpans.has(node.spanId)}
									onToggle={toggleSpan}
									isSelected={selectedSpanId === node.spanId}
									onSelect={onSelectSpan}
								/>
							</div>
						)
					})}
				</div>
			</div>
		</div>
	)
}
