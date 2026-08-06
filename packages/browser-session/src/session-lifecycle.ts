// The one session lifecycle both capture modes run on: `active` row on start,
// heartbeat while visible, `ended` row on hide/rotate/shutdown, and a fresh run
// under the next session after an idle rotation. `startReplaySession` and
// `startMetadataSession` are thin configurations of it — replay additionally
// suspends and resumes the rrweb recorder, which is what `onStart`/`onSuspend`
// are for. Keeping one driver is what stops the two SDKs (and the recorded and
// unrecorded paths within one SDK) from disagreeing about which sessions exist.
import { getActiveSink } from "./events-sink"
import type { ResolvedIdentity } from "./identity"
import { buildSessionMetaRow } from "./meta-row"
import {
	entryContextOf,
	getSession,
	isSessionExpired,
	nextMetaVersion,
	noteCounts,
	onSessionRotate,
	peekSession,
	resolveBillable,
	type SessionRecord,
} from "./session"
import { claimVisit } from "./visit"
import { getVisitorId, isVisitorIdPersisted } from "./visitor"

/**
 * How often a visible tab re-posts its `active` row.
 *
 * This is what makes exit page, page views and duration survive a tab killed
 * without an unload beacon — otherwise the only surviving row is the v1 row
 * posted at session start, whose counters are all zero and therefore read as a
 * bounce. 60s is the floor worth using: the table is a ReplacingMergeTree, so
 * every heartbeat is an unmerged part until the next merge. Billing meters only
 * `billable_start == 1 && version == 1` rows, so heartbeats do not double-bill.
 */
const HEARTBEAT_INTERVAL_MS = 60_000

/** The metadata-row fields a lifecycle owner supplies; identical for both modes. */
export interface SessionLifecycleOptions {
	readonly serviceName: string
	readonly environment?: string | undefined
	readonly serviceVersion?: string | undefined
	/** Consulted when metadata rows are posted, so `identify()` works late. */
	readonly getIdentity?: (() => ResolvedIdentity | undefined) | undefined
	/** When false, `identify()`'s email is not sent to the warehouse. */
	readonly captureUserEmail?: boolean | undefined
	/** Trace ids to attach to the session's `ended` row. */
	readonly getTraceIds?: ((sessionId: string) => ReadonlyArray<string>) | undefined
}

/** Why a run is ending, so owners flush the way the exit path allows. */
export interface SessionSuspendOptions {
	/** False only on a consent revoke, which must discard rather than send. */
	readonly flush: boolean
	/** True when the page may be going away and the write needs `keepalive`. */
	readonly keepalive: boolean
}

/** The parts of the lifecycle each capture mode owns. */
export interface SessionLifecycleHooks {
	/** Whether the rows this owner posts are accompanied by an rrweb recording. */
	readonly recorded: boolean
	/** POST one metadata row. Best-effort — must never throw. */
	readonly post: (row: Record<string, unknown>, keepalive: boolean) => void
	/**
	 * Clicks the owner has counted since the current run started, when it has a
	 * better source than the shared event sink — the rrweb recorder tallies its
	 * own from mouse-interaction events. Omitted, the sink's delta is used.
	 */
	readonly clicksSinceStart?: (() => number) | undefined
	/** Start capture for `record`. Runs before the run's first `active` row. */
	readonly onStart?: ((record: SessionRecord) => void) | undefined
	/**
	 * Stop capture. Runs after the run's `ended` row, so tallies read off live
	 * capture are still available to it. The returned promise is what
	 * `shutdown()` awaits.
	 */
	readonly onSuspend?: ((options: SessionSuspendOptions) => Promise<void> | void) | undefined
	/** The lifecycle moved to a new session id (idle rotation). */
	readonly onSessionChange?: ((sessionId: string) => void) | undefined
}

export interface SessionLifecycleHandle {
	readonly sessionId: string
	readonly shutdown: (options?: { readonly flush?: boolean }) => Promise<void>
}

/** Session tallies as of one metadata row. */
interface SessionCounts {
	readonly clickCount: number
	readonly pageViews: number
	readonly errorCount: number
}

/**
 * Drive one session's metadata lifecycle. Returns undefined outside a browser;
 * sampling and consent are the caller's decisions.
 */
export function startSessionLifecycle(
	options: SessionLifecycleOptions,
	hooks: SessionLifecycleHooks,
): SessionLifecycleHandle | undefined {
	if (typeof window === "undefined") return undefined

	let current = getSession()
	let stopped = false
	/** Whether a run is live: capture started, `active` posted, heartbeat armed. */
	let running = false
	let heartbeat: ReturnType<typeof setInterval> | undefined
	let clickCountBase = 0
	let errorCountBase = 0
	let sinkClickCountAtStart = 0
	let sinkErrorCountAtStart = 0

	/**
	 * The persisted record of the session this lifecycle owns.
	 *
	 * `current` fixes only the identity of the run — counters, `lastUrl` and
	 * `lastActivityAt` move underneath it as the page is used, so a row built
	 * from the captured object alone reports the exit path and page views of the
	 * session's *first* page forever. Reading storage back per row keeps them
	 * live, and the id check keeps a rotation from attributing the incoming
	 * session's context to the outgoing session's `ended` row.
	 */
	const liveRecord = (): SessionRecord => {
		const stored = peekSession()
		return stored?.id === current.id ? stored : current
	}

	/**
	 * Re-baseline the cumulative counters against the persisted record.
	 *
	 * The record is what carries counts across a reload and across a hide/resume
	 * cycle (each `ended` row writes them back via `noteCounts`), while live
	 * capture restarts from zero every run — so a run's row is the persisted base
	 * plus what capture has seen since this run began.
	 */
	const rebaseCounts = (record: SessionRecord): void => {
		clickCountBase = record.clickCount ?? 0
		errorCountBase = record.errorCount ?? 0
		const sink = getActiveSink()
		sinkClickCountAtStart = sink?.getClickCount() ?? 0
		sinkErrorCountAtStart = sink?.getErrorCount() ?? 0
	}

	const countsFor = (record: SessionRecord): SessionCounts => {
		const sink = getActiveSink()
		// A sink published under another id belongs to a session that already
		// rotated past this one; its tallies are not ours to add.
		const sinkMatches = sink !== undefined && sink.sessionId === record.id
		const clicks =
			hooks.clicksSinceStart?.() ?? (sinkMatches ? sink.getClickCount() - sinkClickCountAtStart : 0)
		const errors = sinkMatches ? sink.getErrorCount() - sinkErrorCountAtStart : 0
		const counts: SessionCounts = {
			clickCount: clickCountBase + Math.max(0, clicks),
			errorCount: errorCountBase + Math.max(0, errors),
			pageViews: record.pageViews ?? (sinkMatches ? sink.getPageViews() : 0),
		}
		// Only ever onto this session's own record — a rotation installs the next
		// one between the `ended` row being built and the next post.
		if (peekSession()?.id === record.id) {
			noteCounts({ clickCount: counts.clickCount, errorCount: counts.errorCount })
		}
		return counts
	}

	const post = (status: "active" | "ended", keepalive: boolean): void => {
		const record = liveRecord()
		const counts = countsFor(record)
		hooks.post(
			buildSessionMetaRow({
				sessionId: record.id,
				startedAt: new Date(record.startedAt),
				version: nextMetaVersion(),
				status,
				serviceName: options.serviceName,
				identity: options.getIdentity?.(),
				captureUserEmail: options.captureUserEmail,
				environment: options.environment,
				serviceVersion: options.serviceVersion,
				visitorId: getVisitorId(),
				// Off the record being posted rather than re-read from storage: the
				// record already carries it, and the two can only disagree.
				visitorIsNew: record.visitorIsNew === true,
				visitorIdPersisted: isVisitorIdPersisted(),
				// Asked once per session and then read back off the record, so every
				// row of a session agrees about whether it was charged. A second tab
				// and a second subdomain reach this too and get `false` — they are
				// real sessions, just not separate charges.
				billableStart: resolveBillable(record.id, claimVisit),
				entry: entryContextOf(record),
				lastUrl: record.lastUrl,
				clickCount: counts.clickCount,
				pageViews: counts.pageViews,
				errorCount: counts.errorCount,
				traceIds: status === "ended" ? options.getTraceIds?.(record.id) : undefined,
				recorded: hooks.recorded,
			}),
			keepalive,
		)
	}

	const stopHeartbeat = (): void => {
		if (heartbeat === undefined) return
		clearInterval(heartbeat)
		heartbeat = undefined
	}

	const startRun = (): void => {
		if (stopped || running) return
		running = true
		const record = liveRecord()
		rebaseCounts(record)
		hooks.onStart?.(record)
		post("active", false)
		heartbeat = setInterval(() => {
			if (typeof document !== "undefined" && document.visibilityState !== "visible") return
			// A visible tab nobody is using still crosses the idle window. Ending the
			// session here is the whole point of that window: heartbeating it instead
			// stretches one abandoned tab into an hours-long session whose duration is
			// wall-clock rather than active time, and whose `ended` row only lands
			// when the tab is finally closed. Dormant is the correct state until real
			// activity rotates the session — which re-arms this lifecycle through the
			// rotation listener below.
			//
			// Expiry is judged on the *persisted* record, not the one captured when
			// the run started: `lastActivityAt` is bumped by every span and captured
			// event, and none of those writes reach the captured object.
			if (isSessionExpired(liveRecord())) {
				endRun({ flush: true, keepalive: false })
				return
			}
			post("active", false)
		}, HEARTBEAT_INTERVAL_MS)
	}

	const endRun = (suspend: SessionSuspendOptions): Promise<void> | void => {
		if (!running) return
		running = false
		stopHeartbeat()
		if (suspend.flush) post("ended", suspend.keepalive)
		return hooks.onSuspend?.(suspend)
	}

	const stopRotationListener = onSessionRotate((previous, next) => {
		if (stopped || previous.id !== current.id) return
		// Not keepalive: rotation is discovered by activity in a live tab, never on
		// the way out, and the keepalive budget is shared with the unload writes.
		endRun({ flush: true, keepalive: false })
		current = next
		hooks.onSessionChange?.(next.id)
		// The replacement record is written by the rotating caller immediately
		// after this listener returns, so defer: the new run's baselines and its
		// `active` row must read that record, not the one being replaced.
		queueMicrotask(() => startRun())
	})

	const onPageHide = (): void => void endRun({ flush: true, keepalive: true })
	const onVisibilityChange = (): void => {
		const doc = (globalThis as Record<string, any>)["document"]
		if (!doc) return
		if (doc.visibilityState === "hidden") {
			void endRun({ flush: true, keepalive: true })
			return
		}
		// Back in view. The session may have gone idle while hidden — resolving it
		// rotates in that case, and the rotation listener above re-arms under the
		// new id, so this must not resume the expired one.
		if (isSessionExpired(liveRecord())) {
			getSession()
			return
		}
		startRun()
	}

	// `visibilitychange` is fired at the document (and bubbles to the window); a
	// non-DOM embedder gets neither and simply runs without visibility handling.
	const visibilityTarget: EventTarget | undefined =
		typeof document !== "undefined" && typeof document.addEventListener === "function"
			? document
			: typeof globalThis.addEventListener === "function"
				? globalThis
				: undefined
	// `visibilitychange → hidden` is the reliable "leaving" signal on mobile;
	// pagehide covers desktop tab close / navigation. A bfcache restore fires
	// `visibilitychange → visible`, which resumes capture.
	const pageHideTarget: EventTarget | undefined =
		typeof globalThis.addEventListener === "function" ? globalThis : undefined

	startRun()
	visibilityTarget?.addEventListener("visibilitychange", onVisibilityChange)
	pageHideTarget?.addEventListener("pagehide", onPageHide)

	return {
		get sessionId() {
			return current.id
		},
		shutdown: async (shutdownOptions) => {
			if (stopped) return
			stopped = true
			stopRotationListener()
			visibilityTarget?.removeEventListener("visibilitychange", onVisibilityChange)
			pageHideTarget?.removeEventListener("pagehide", onPageHide)
			const flush = shutdownOptions?.flush ?? true
			await endRun({ flush, keepalive: flush })
		},
	}
}
