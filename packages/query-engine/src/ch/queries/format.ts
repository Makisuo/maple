// ---------------------------------------------------------------------------
// Shared output-shaping helpers for timeseries queries.
//
// These are not Cloudflare-specific despite most of the callers living there —
// PlanetScale, usage and alert-check queries format buckets the same way, and
// the format string has to match what the frontend parses.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"

/**
 * ISO-8601 with a literal `Z`. ClickHouse `DateTime` has no zone, so the suffix
 * is asserted rather than converted — every warehouse timestamp is already UTC,
 * and without it `new Date(...)` on the client reads the value as local time.
 */
export const ISO_Z_FORMAT = "%Y-%m-%dT%H:%i:%S.%fZ"

/**
 * The bucket column every timeseries query selects: the timestamp snapped down
 * to the caller's interval, rendered as an ISO-Z string.
 */
export function isoBucket(column: CH.Expr<string>): CH.Expr<string> {
	return CH.formatDateTime(CH.toStartOfInterval(column, param.int("bucketSeconds")), ISO_Z_FORMAT)
}

/**
 * Average of `value` over rows matching `cond`, or 0 when none match.
 *
 * `avgIf` over an empty set is NaN, which serializes to JSON `null` and breaks
 * row decoding — the guard is the reason this exists rather than a bare
 * `CH.avgIf`.
 */
export function avgWhere(value: CH.Expr<number>, cond: CH.Condition): CH.Expr<number> {
	return CH.if_(CH.countIf(cond).gt(0), CH.avgIf(value, cond), CH.lit(0))
}
