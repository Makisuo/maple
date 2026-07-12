/**
 * SQLCommenter (https://google.github.io/sqlcommenter/) trace-context parsing.
 *
 * SQLCommenter — now merged into the OpenTelemetry specification as the standard
 * way to correlate database queries with APM traces — propagates trace context
 * into a database by appending a machine-readable comment to the query text:
 *
 *   SELECT * FROM songs WHERE id = ? /​*traceparent='00-<trace_id>-<span_id>-01'*​/
 *
 * The database records the full query (comment included) in its query log
 * (e.g. ClickHouse `system.query_log`), so reading that log back lets us stitch
 * a server-side query row to the client span that issued it — nesting the
 * server-side query as a child of the app's DB span.
 *
 * This module extracts the W3C `traceparent` from such a comment. Pure string
 * parsing, no imports, so it is safe to pull into the web / cli / scraper
 * bundles alike.
 */

/** The W3C trace-context fields carried by a `traceparent`. */
export interface Traceparent {
	/** 32-hex-char trace id (lowercase). */
	readonly traceId: string
	/** 16-hex-char parent span id (lowercase). */
	readonly spanId: string
	/** 2-hex-char trace-flags byte (e.g. "01"). */
	readonly flags: string
	/** Whether the `sampled` flag (bit 0 of trace-flags) is set. */
	readonly sampled: boolean
}

// version "-" trace-id "-" span-id "-" trace-flags, all lowercase hex.
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

// Pull `traceparent='<value>'` out of a SQLCommenter comment. Per the spec the
// value is URL-encoded and single-quoted; accept double quotes defensively.
const COMMENT_VALUE_RE = /traceparent\s*=\s*(['"])([^'"]+)\1/i

/** An all-zero id is invalid per the W3C spec — treat it as absent. */
const isAllZero = (hex: string): boolean => /^0+$/.test(hex)

/**
 * Extract the W3C `traceparent` from a SQLCommenter comment embedded anywhere in
 * `sql`. Returns `null` when absent or malformed (all-zero ids counted as
 * malformed). The parse is case- and whitespace-tolerant and URL-decodes the
 * value defensively.
 */
export function parseSqlCommenterTraceparent(sql: string | null | undefined): Traceparent | null {
	if (!sql) return null

	const commentMatch = COMMENT_VALUE_RE.exec(sql)
	if (!commentMatch) return null

	let raw = commentMatch[2]
	try {
		raw = decodeURIComponent(raw)
	} catch {
		// Leave `raw` as-is when it isn't valid percent-encoding.
	}

	const parts = TRACEPARENT_RE.exec(raw.trim().toLowerCase())
	if (!parts) return null

	const [, , traceId, spanId, flags] = parts
	if (isAllZero(traceId) || isAllZero(spanId)) return null

	return {
		traceId,
		spanId,
		flags,
		sampled: (Number.parseInt(flags, 16) & 0x01) === 1,
	}
}
