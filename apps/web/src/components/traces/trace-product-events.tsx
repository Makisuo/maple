import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { productEventsForTraceResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ChartBarTrendUpIcon } from "@/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import type { TraceProductEvent } from "@/api/warehouse/product-events"

/** Same margin and reasoning as `TraceLogsLink`: clock skew between services can
 *  stamp an annotated span slightly outside the root span's own window, and the
 *  bound is also what keeps the lookup off every retained partition. */
const WINDOW_MARGIN_MS = 5 * 60 * 1000

/**
 * The product events this trace produced — spans the team annotated in their own
 * code with `maple.product_event.name`.
 *
 * Renders nothing while loading, on failure, and when the trace produced none,
 * which is the overwhelming majority of traces. That silence is the whole design
 * of the panel: it sits unconditionally in the trace body and only appears on
 * the traces where a request actually accomplished something the business
 * counts, so it reads as a finding rather than as another empty section.
 *
 * Clicking an event selects its span in the waterfall, which is the point of the
 * link — "the conversion happened, and here is the code path that did it."
 */
export function TraceProductEvents({
	traceId,
	traceStartTime,
	totalDurationMs,
	onSelectSpan,
}: {
	traceId: string
	traceStartTime: string
	totalDurationMs: number
	onSelectSpan: (spanId: string) => void
}) {
	const traceStartMs = parseWarehouseDateTime(traceStartTime)
	if (Number.isNaN(traceStartMs)) return null
	return (
		<LoadedTraceProductEvents
			traceId={traceId}
			startTime={formatWarehouseDateTime(traceStartMs - WINDOW_MARGIN_MS)}
			endTime={formatWarehouseDateTime(traceStartMs + totalDurationMs + WINDOW_MARGIN_MS)}
			onSelectSpan={onSelectSpan}
		/>
	)
}

/**
 * Split out so the unparseable-timestamp case never constructs an atom key at
 * all. Folding the guard in after the `useAtomValue` — passing `?? ""` to
 * satisfy the required time fields — mounts the atom, fails `decodeInput`
 * against `TinybirdDateTime`, and exports a `QueryEngine.getProductEventsForTrace`
 * failure span on every render, for a query nobody wanted. It happened not to
 * reach the network only because that schema rejects `""`; a later change making
 * the window optional-with-fallback (which the logs client already does) would
 * have turned it into a real full-window warehouse read.
 */
function LoadedTraceProductEvents({
	traceId,
	startTime,
	endTime,
	onSelectSpan,
}: {
	traceId: string
	startTime: string
	endTime: string
	onSelectSpan: (spanId: string) => void
}) {
	const result = useAtomValue(productEventsForTraceResultAtom({ data: { traceId, startTime, endTime } }))

	return Result.builder(result)
		.onSuccess((response) => {
			if (response.data.length === 0) return null
			return (
				<section className="rounded-md border">
					<header className="flex items-center gap-2 border-b px-3 py-2">
						<ChartBarTrendUpIcon className="size-3.5 text-muted-foreground" />
						<h2 className="text-xs font-medium">Product events</h2>
						<span className="text-xs text-muted-foreground">{response.data.length}</span>
					</header>
					<ul className="divide-y">
						{/* Index, not spanId+eventName: `SpanId` is '' on any row that
						    reached the table without a span, so two same-named events in
						    one trace collide on that key — and at-least-once ingest can
						    duplicate a row outright. The list is ordered by the server
						    and never reordered client-side, so the index is stable. */}
						{response.data.map((event, index) => (
							<ProductEventRow
								key={`${index}:${event.spanId}:${event.eventName}`}
								event={event}
								onSelectSpan={onSelectSpan}
							/>
						))}
					</ul>
				</section>
			)
		})
		.onError(() => null)
		.orElse(() => null)
}

function ProductEventRow({
	event,
	onSelectSpan,
}: {
	event: TraceProductEvent
	onSelectSpan: (spanId: string) => void
}) {
	// UserId first, then GroupId, then VisitorId — the same precedence the funnel
	// person key uses, so the identity shown here is the one the event will be
	// counted under rather than whichever field happened to be set.
	const person = event.userId || event.groupId || event.visitorId
	const props = Object.entries(event.attributes)

	const content = (
		<>
			<span className="font-medium">{event.eventName}</span>
			{event.serviceName === "" ? null : (
				<span className="text-muted-foreground">{event.serviceName}</span>
			)}
			{person === "" ? null : <span className="text-muted-foreground">· {person}</span>}
			{props.map(([key, value]) => (
				<Badge key={key} variant="secondary" className="font-normal">
					{key}: {value}
				</Badge>
			))}
		</>
	)
	const rowClassName = "flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-xs"

	// A row with no span to select is a plain row, not a disabled button. As a
	// disabled button its whole content — event name, identity, props — leaves
	// the tab order and is unreachable by keyboard, while a mouse user gets no
	// cue at all: there is no dimming, only a hover highlight that silently
	// doesn't appear. The information is worth reading either way; only the
	// navigation is unavailable.
	if (event.spanId === "") {
		return <li className={rowClassName}>{content}</li>
	}

	return (
		<li>
			<button
				type="button"
				onClick={() => onSelectSpan(event.spanId)}
				className={`${rowClassName} hover:bg-muted focus-visible:bg-muted focus-visible:outline-none`}
			>
				{content}
			</button>
		</li>
	)
}
