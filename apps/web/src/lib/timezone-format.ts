import { warehouseDateTimeToIso } from "@maple/query-engine"

/**
 * Normalize a tz-less warehouse (Tinybird/ClickHouse) DateTime string to an
 * explicit-UTC ISO string. Delegates to the canonical shared helper so web,
 * mobile, and the API all agree on one normalization.
 *
 * Absolute-time *formatting* lives in `@maple/ui/lib/time-format` (via the
 * `useTimeFormat()` hook); this module only keeps the shared input
 * normalization that ~30 call sites depend on.
 */
export function normalizeTimestampInput(value: string): string {
	return warehouseDateTimeToIso(value)
}
