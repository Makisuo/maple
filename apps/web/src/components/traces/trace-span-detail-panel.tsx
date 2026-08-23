import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { Schema } from "effect"
import { TraceId } from "@maple/domain"

import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { findSpanById } from "@maple/ui/components/traces/flow-utils"
import { cn } from "@maple/ui/lib/utils"

import { ExternalLinkIcon, XmarkIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { SpanDetailPanel } from "@/components/traces/span-detail-panel"
import type { SpanHierarchyResponse } from "@/api/warehouse/traces"
import { getSpanHierarchyResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { Result, useAtomValue } from "@/lib/effect-atom"

interface TraceSpanDetailPanelProps {
	traceId: string
	/** Any timestamp inside the trace, to narrow the warehouse partition scan. */
	timestamp?: string
	/** The trace's root span when absent — a trace-level click still shows something. */
	selectedSpanId?: string
	onClose: () => void
	className?: string
}

/**
 * The span detail panel from the trace page, mounted beside whichever page
 * opened it. The hierarchy read exists only to resolve the clicked span id into
 * the `SpanNode` shape the panel takes (and the trace timings its position bar
 * needs); the full trace page stays one header click away.
 */
export function TraceSpanDetailPanel({
	traceId,
	timestamp,
	selectedSpanId,
	onClose,
	className,
}: TraceSpanDetailPanelProps) {
	const result = useAtomValue(
		getSpanHierarchyResultAtom({
			data: { traceId: Schema.decodeSync(TraceId)(traceId), timestamp },
		}),
	)

	return (
		// No leading border: the rail this mounts in draws its own.
		<div className={cn("flex h-full min-h-0 flex-col overflow-hidden bg-background", className)}>
			{Result.builder(result)
				.onInitial(() => (
					<>
						<PanelCloseBar onClose={onClose} />
						<div className="space-y-2 p-3">
							<Skeleton className="h-5 w-2/3" />
							<Skeleton className="h-1.5 w-full rounded-full" />
							{Array.from({ length: 8 }).map((_, index) => (
								<Skeleton key={index} className="h-4 w-full" />
							))}
						</div>
					</>
				))
				.onError((error) => (
					<>
						<PanelCloseBar onClose={onClose} />
						<div className="min-h-0 flex-1 overflow-auto p-3">
							<QueryErrorState error={error} titleOverride="Failed to load span details" />
						</div>
					</>
				))
				.onSuccess((data) => (
					<PanelSpan
						data={data}
						traceId={traceId}
						timestamp={timestamp}
						selectedSpanId={selectedSpanId}
						onClose={onClose}
					/>
				))
				.render()}
		</div>
	)
}

/** The success branch gets its close button from `SpanDetailPanel`'s own header;
 *  every other branch renders this, so the panel is always dismissable. */
function PanelCloseBar({ onClose }: { onClose: () => void }) {
	return (
		<div className="flex shrink-0 items-center justify-end border-b p-1.5">
			<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close span details">
				<XmarkIcon size={16} />
			</Button>
		</div>
	)
}

function PanelSpan({
	data,
	traceId,
	timestamp,
	selectedSpanId,
	onClose,
}: {
	data: SpanHierarchyResponse
	traceId: string
	timestamp: string | undefined
	selectedSpanId: string | undefined
	onClose: () => void
}) {
	// No fallback for a span that was asked for and is not here: the read is
	// capped and windowed, so substituting the root would show a different span
	// than the one clicked, with no signal. Only a trace-level click (no span id)
	// falls back — to a real root, never one the tree builder synthesised for
	// orphans.
	const span = useMemo(
		() =>
			selectedSpanId === undefined
				? (data.rootSpans.find((root) => !root.isMissing) ?? data.rootSpans[0])
				: findSpanById(data.rootSpans, selectedSpanId),
		[data.rootSpans, selectedSpanId],
	)

	const { traceStartTime } = data
	if (span === undefined || traceStartTime === undefined) {
		return (
			<>
				<PanelCloseBar onClose={onClose} />
				<p className="p-6 text-center text-muted-foreground text-sm">
					No matching span was found for this trace. It may have expired, not been ingested yet, or
					fall outside the window this panel reads.
				</p>
			</>
		)
	}

	return (
		<SpanDetailPanel
			span={span}
			onClose={onClose}
			traceStartTime={traceStartTime}
			totalDurationMs={data.totalDurationMs}
			// The rail this mounts in owns the leading edge, so the panel drops its own.
			className="min-h-0 flex-1 border-l-0"
			headerActions={
				<Link
					to="/traces/$traceId"
					params={{ traceId }}
					search={{ t: timestamp, spanId: span.spanId }}
					aria-label="Open the full trace"
					title="Open the full trace"
					className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					<ExternalLinkIcon size={14} />
				</Link>
			}
		/>
	)
}
