import { Link } from "@tanstack/react-router"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getLogsCountResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { FileIcon } from "@/components/icons"

/** Clock skew between services can stamp a correlated log slightly outside the
 *  trace's own span window; the margin also narrows the partition scan the same
 *  way the trace page's `t` param does. */
const WINDOW_MARGIN_MS = 5 * 60 * 1000

/**
 * Renders a "View Logs (N)" link into the trace-scoped /logs stream when any
 * log carries this trace ID. Silent (renders nothing) while loading, on
 * failure, and when no logs correlate — same contract as `TraceReplayLink`,
 * so it can sit in the trace header unconditionally.
 */
export function TraceLogsLink({
	traceId,
	traceStartTime,
	totalDurationMs,
}: {
	traceId: string
	traceStartTime: string
	totalDurationMs: number
}) {
	const traceStartMs = parseWarehouseDateTime(traceStartTime)
	const window = Number.isNaN(traceStartMs)
		? undefined
		: {
				startTime: formatWarehouseDateTime(traceStartMs - WINDOW_MARGIN_MS),
				endTime: formatWarehouseDateTime(traceStartMs + totalDurationMs + WINDOW_MARGIN_MS),
			}

	const result = useAtomValue(
		getLogsCountResultAtom({
			data: { traceId, startTime: window?.startTime, endTime: window?.endTime },
		}),
	)

	if (window === undefined) return null

	return Result.builder(result)
		.onSuccess((response) => {
			const total = response.data[0]?.total ?? 0
			if (total === 0) return null
			return (
				<Link
					to="/logs"
					search={{ traceId, startTime: window.startTime, endTime: window.endTime }}
					className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted"
				>
					<FileIcon className="size-3.5" /> View Logs ({total})
				</Link>
			)
		})
		.onError(() => null)
		.orElse(() => null)
}
