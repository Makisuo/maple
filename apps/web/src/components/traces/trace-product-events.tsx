import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { productEventsForTraceResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ChartBarTrendUpIcon } from "@/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import type { TraceProductEvent } from "@/api/warehouse/product-events"

/** Same margin as `TraceLogsLink`: clock skew can stamp an annotated span just
 *  outside the root span's window, and the bound keeps the lookup partition-pruned. */
const WINDOW_MARGIN_MS = 5 * 60 * 1000

/**
 * The product events this trace produced. Renders nothing while loading, on
 * failure, and when there are none (most traces), so it reads as a finding
 * rather than another empty section. Clicking an event selects its span.
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

// Split out so an unparseable timestamp never mounts the atom: folding the guard
// in after `useAtomValue` would fail `decodeInput` and export a failure span on
// every render for a query nobody wanted.
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
						{/* Index included: at-least-once ingest can duplicate a row, and the
						    server-ordered list is never reordered client-side. */}
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
	// Same precedence as the funnel person key, so this is the identity the event
	// is counted under.
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

	// A row with no span to select is a plain row, not a disabled button: a
	// disabled button drops its content out of the tab order.
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
