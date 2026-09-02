const DEFAULT_CACHE_SECONDS = 15

export interface DirectRouteCachePolicy {
	/** Bump when response or key semantics change incompatibly. */
	readonly version: number
	readonly ttlSeconds: number
	readonly snapWindowSeconds: number
}

export type DirectRouteCachePolicyInput = number | DirectRouteCachePolicy

export function makeDirectRouteCachePolicy(
	options: {
		readonly ttlSeconds?: number
		readonly snapWindowSeconds?: number
		readonly version?: number
	} = {},
): DirectRouteCachePolicy {
	// `Number.isFinite` narrows nothing on an optional field — bind the value and
	// test the binding so the branch and the type agree.
	const requestedTtl = options.ttlSeconds
	const ttlSeconds =
		requestedTtl !== undefined && Number.isFinite(requestedTtl)
			? Math.max(1, Math.floor(requestedTtl))
			: DEFAULT_CACHE_SECONDS
	const requestedSnap = options.snapWindowSeconds ?? ttlSeconds
	const snapWindowSeconds = Number.isFinite(requestedSnap)
		? Math.min(3600, Math.max(1, Math.floor(requestedSnap)))
		: DEFAULT_CACHE_SECONDS
	const requestedVersion = options.version
	const version =
		requestedVersion !== undefined && Number.isFinite(requestedVersion)
			? Math.max(1, Math.floor(requestedVersion))
			: 1
	return { version, ttlSeconds, snapWindowSeconds }
}

export function resolveDirectRouteCachePolicy(
	input: DirectRouteCachePolicyInput = DEFAULT_CACHE_SECONDS,
): DirectRouteCachePolicy {
	return typeof input === "number"
		? makeDirectRouteCachePolicy({ ttlSeconds: input })
		: makeDirectRouteCachePolicy(input)
}

/**
 * Divisor turning a query's time span into its cache-key snap window: a 24h
 * range snaps to 5 minutes, roughly one pixel on a day-wide chart. Keeping the
 * snap proportional to the span is what makes a wide window safe — the blur it
 * introduces is always the same fraction of the range being asked about, so a
 * 7d chart never gets a coarser answer *relative to itself* than an hourly one.
 */
const SNAP_WINDOW_DIVISOR = 288
const MIN_SNAP_WINDOW_SECONDS = 15
/** `snapToWindow` passes the value through untouched above 3600s. Stay well inside. */
const MAX_SNAP_WINDOW_SECONDS = 900

/**
 * A window whose end is at least this far behind now is treated as settled.
 *
 * The bound is ingestion lag, not immutability: spans keep arriving for a window
 * after it closes, so a range ending 30s ago is still moving. Fifteen minutes is
 * past the point where late arrivals meaningfully change an aggregate, which is
 * what lets a settled range hold a long TTL — its key is fixed (absolute
 * timestamps snap to themselves), so a revisit hits directly.
 */
const SETTLED_END_AGE_SECONDS = 900
const SETTLED_TTL_SECONDS = 900

/** Parse a Tinybird datetime (`YYYY-MM-DD HH:MM:SS`, UTC) to epoch ms. */
const parseWarehouseTime = (value: unknown): number | undefined => {
	if (typeof value !== "string") return undefined
	if (value.length !== 19 || value[4] !== "-" || value[10] !== " ") return undefined
	const ms = Date.parse(`${value.replace(" ", "T")}Z`)
	return Number.isNaN(ms) ? undefined : ms
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export interface TimeRangeCachePayload {
	readonly startTime?: unknown
	readonly endTime?: unknown
}

/**
 * Derive TTL and snap window from the query's own time range.
 *
 * The fixed 15s default this replaces could only ever hit when two requests for
 * the same query landed inside the same 15-second wall-clock window, because the
 * snap window and the TTL were both 15s — the key changed as fast as the entry
 * expired. Measured in production: **zero hits in 73 reads** on the `qe-direct`
 * bucket. Interactive navigation (leave a page, come back 30s later) was a
 * guaranteed miss on a freshly-minted key, so every dashboard query paid the
 * full warehouse cost (p50 447ms).
 *
 * Scaling with the span fixes that without trading away freshness where
 * freshness is the product: a "last 15 minutes" view keeps the 15s floor, while
 * a "last 24 hours" view — where a minute of staleness is invisible — snaps to
 * five minutes and actually accumulates hits.
 */
export function makeTimeRangeCachePolicy(options: { readonly version?: number } = {}) {
	return (payload: TimeRangeCachePayload, nowMs: number): DirectRouteCachePolicy => {
		const startMs = parseWarehouseTime(payload?.startTime)
		const endMs = parseWarehouseTime(payload?.endTime)
		// An unparseable or inverted range keeps the old conservative default
		// rather than guessing a window from values we could not read.
		if (startMs === undefined || endMs === undefined || endMs <= startMs) {
			return makeDirectRouteCachePolicy({ version: options.version })
		}

		const spanSeconds = (endMs - startMs) / 1000
		const snapWindowSeconds = clamp(
			Math.round(spanSeconds / SNAP_WINDOW_DIVISOR),
			MIN_SNAP_WINDOW_SECONDS,
			MAX_SNAP_WINDOW_SECONDS,
		)
		const settled = nowMs - endMs >= SETTLED_END_AGE_SECONDS * 1000
		return makeDirectRouteCachePolicy({
			// TTL matches the snap window for a live range: an entry only needs to
			// outlive the key that addresses it, and that key changes every window.
			ttlSeconds: settled ? Math.max(snapWindowSeconds, SETTLED_TTL_SECONDS) : snapWindowSeconds,
			snapWindowSeconds,
			version: options.version,
		})
	}
}

/** Shared instance for the common case — no version pin. */
export const timeRangeCache = makeTimeRangeCachePolicy()
