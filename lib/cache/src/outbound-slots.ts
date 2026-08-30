import { Effect } from "effect"

/**
 * A count of outbound I/O currently holding one of the runtime's simultaneous
 * connection slots (Cloudflare Workers caps these at six per invocation:
 * https://developers.cloudflare.com/workers/platform/limits/).
 *
 * This exists as a *deterministic* alternative to the per-bucket timeout-rate
 * breaker in `edge-cache.ts`. That breaker needs samples, and a bucket whose
 * reads land one-per-isolate across a request fan-out never accumulates any —
 * measured on the org-config bucket: the most timeouts of any bucket (508 in a
 * day) and zero breaker skips, because each isolate reads it at most once per
 * memo window. A signal that predicts the *next* read's fate from the present
 * — "is a connection slot held right now?" — needs no history at all, so it
 * works on the very first read of a cold isolate.
 *
 * Isolate-scoped rather than request-scoped, deliberately. Slot budgets are
 * per-invocation, so an isolate-wide count over-reports pressure when
 * concurrent requests share the isolate — but the measured timeouts are not
 * explained by in-request activity alone (only ~30% of timed-out config reads
 * had a warehouse query in flight in their own trace), and the cost asymmetry
 * absorbs the imprecision: a wrongly skipped read costs its caller the compute
 * (~20ms for the buckets that opt in), an avoided timeout saves ~600ms and a
 * held slot. Being module state also means no per-request wiring: every entry
 * point — HTTP, cron, workflows — is covered by construction.
 */
export interface OutboundSlotsCell {
	/** How many outbound calls currently hold a connection slot. */
	readonly held: () => number
	readonly acquire: () => void
	readonly release: () => void
}

export const makeOutboundSlotsCell = (): OutboundSlotsCell => {
	let held = 0
	return {
		held: () => held,
		acquire: () => {
			held += 1
		},
		// Floored at zero so a double-release bug degrades the signal instead of
		// poisoning it into permanently negative territory.
		release: () => {
			held = Math.max(0, held - 1)
		},
	}
}

/** The isolate-wide cell. Production code shares this one; tests inject their own. */
export const isolateOutboundSlots: OutboundSlotsCell = makeOutboundSlotsCell()

/**
 * Count `effect` as holding an outbound connection slot while it runs.
 *
 * Wrap the narrowest effect that actually has a connection open — a driver
 * call, a client fetch — not a span that includes preamble or retry sleeps.
 * Release is exit-agnostic (success, failure, interruption). One caveat:
 * interrupting a wrapped `Effect.tryPromise` releases the slot even though the
 * underlying promise (and its connection) may still be in flight — the wrapper
 * cannot see promise settlement from out here, so an interrupted call
 * under-reports for as long as its fetch lingers.
 */
export const trackOutboundSlot = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	cell: OutboundSlotsCell = isolateOutboundSlots,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => cell.acquire()),
		() => effect,
		() => Effect.sync(() => cell.release()),
	)
