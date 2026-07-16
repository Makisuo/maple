import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Button } from "../ui/button"
import { SpanRow } from "./span-row"
import { useTraceView } from "./trace-view-context"
import { collectAllCollapsibleIds, computeDefaultExpandedSpanIds } from "./auto-collapse"
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
	const { rootSpans, totalDurationMs, traceStartTime, selectedSpanId, onSelectSpan } =
		useTraceView()

	const [expandedSpans, setExpandedSpans] = React.useState<Set<string>>(() => {
		return computeDefaultExpandedSpanIds(rootSpans, { keepVisibleSpanId: selectedSpanId })
	})

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
