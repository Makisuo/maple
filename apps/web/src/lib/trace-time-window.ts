import { formatWarehouseDateTime } from "@maple/query-engine"
/**
 * Derive a warehouse query window around a single trace timestamp.
 *
 * A trace (and its logs) lives in a narrow time range, but `TraceId` is not in
 * the warehouse sort keys, so an unbounded trace lookup scans whole partitions.
 * Bounding to ±`halfWidthHours` around any timestamp from the trace lets
 * ClickHouse prune partitions while still comfortably covering clock skew
 * between services.
 *
 * Output is the `YYYY-MM-DD HH:MM:SS` shape accepted by
 * `WarehouseDateTimeString` / `TinybirdDateTime`. Returns `undefined` when the
 * timestamp is missing or unparseable, so callers can spread the result and
 * fall back to the query's default window.
 */
const DEFAULT_HALF_WIDTH_HOURS = 1

export function computeTraceTimeWindow(
	timestamp: string | undefined,
	halfWidthHours = DEFAULT_HALF_WIDTH_HOURS,
): { startTime: string; endTime: string } | undefined {
	if (!timestamp) return undefined
	// Accept both ISO (`...T...Z`) and ClickHouse DateTime64 (`YYYY-MM-DD HH:MM:SS[.fff]`).
	const t = new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`)
	if (Number.isNaN(t.getTime())) return undefined
	const halfWidthMs = halfWidthHours * 60 * 60 * 1000
	return {
		startTime: formatWarehouseDateTime(t.getTime() - halfWidthMs),
		endTime: formatWarehouseDateTime(t.getTime() + halfWidthMs),
	}
}
