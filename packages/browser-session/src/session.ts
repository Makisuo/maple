const STORAGE_KEY = "maple.session"

/** Rotate the session after this much inactivity (PostHog's default). */
const IDLE_TIMEOUT_MS = 30 * 60_000
/** Hard cap on a single session's lifetime regardless of activity. */
const MAX_SESSION_MS = 24 * 60 * 60_000
/**
 * `getSessionId` runs per span creation; persisting the activity bump on every
 * call would hammer sessionStorage for no benefit — rotation correctness only
 * needs sub-idle-timeout granularity.
 */
const ACTIVITY_TOUCH_THROTTLE_MS = 5_000

/**
 * A bounded browser session. Persisted in sessionStorage so it survives reloads
 * *within* a tab, but rotated once activity has been idle past `IDLE_TIMEOUT_MS`
 * (or the session is older than `MAX_SESSION_MS`) — the same activity-window
 * model PostHog uses. Bounding the session is what keeps a tab left open for
 * hours from collapsing into one giant replay whose wall-clock length dwarfs the
 * actual active time.
 */
export interface SessionRecord {
	id: string
	/** epoch ms — session start, stable across reloads within the window. */
	startedAt: number
	/** epoch ms — bumped on activity; drives idle rotation. */
	lastActivityAt: number
	/**
	 * Next replay chunk seq — monotonic across reloads so blobs never collide.
	 * Only `@maple-dev/browser`'s replay recorder consumes it, but it is part of
	 * the persisted record shape every writer must preserve: `readRecord`
	 * rejects records where it is missing.
	 */
	chunkSeq: number
	/**
	 * Last session-metadata row version issued for this session. The backend
	 * resolves each field with `argMax(field, Version)`, so versions must be
	 * strictly increasing across every writer (either SDK, across reloads and
	 * hide/resume cycles) for the latest row to win. Optional for
	 * backwards-compat with records written before it existed — those already
	 * used versions 1 (active) and 2 (ended), so the absent case resumes at 2.
	 */
	metaVersion?: number
}

/** In-memory fallback when sessionStorage is unavailable (private mode). */
let ephemeral: SessionRecord | undefined

function freshRecord(now: number): SessionRecord {
	return { id: crypto.randomUUID(), startedAt: now, lastActivityAt: now, chunkSeq: 0, metaVersion: 0 }
}

function readRecord(): SessionRecord | undefined {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY)
		if (!raw) return undefined
		const parsed = JSON.parse(raw) as Partial<SessionRecord>
		if (
			typeof parsed.id === "string" &&
			typeof parsed.startedAt === "number" &&
			typeof parsed.lastActivityAt === "number" &&
			typeof parsed.chunkSeq === "number"
		) {
			return parsed as SessionRecord
		}
		return undefined
	} catch {
		return ephemeral
	}
}

function writeRecord(record: SessionRecord): void {
	ephemeral = record
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record))
	} catch {
		// Private mode / storage disabled — the ephemeral copy is the source of truth.
	}
}

function isExpired(record: SessionRecord, now: number): boolean {
	return now - record.lastActivityAt > IDLE_TIMEOUT_MS || now - record.startedAt > MAX_SESSION_MS
}

/**
 * Resolve the active session, rotating to a fresh one if the previous session
 * has gone idle (or hit the lifetime cap). Touches `lastActivityAt` so calling
 * it on page load keeps a live session alive. The id is the correlation key
 * shared by OTel traces and replay events.
 */
export function getSession(): SessionRecord {
	const now = Date.now()
	const existing = readRecord()
	const record =
		existing && !isExpired(existing, now) ? { ...existing, lastActivityAt: now } : freshRecord(now)
	writeRecord(record)
	return record
}

/**
 * Resolve the active session id, minting/rotating as needed. Safe to call per
 * span: the activity touch is only persisted when the recorded activity is
 * older than `ACTIVITY_TOUCH_THROTTLE_MS`. Returns `undefined` outside a
 * browser (SSR) so server renders never mint a session shared across requests.
 */
export function getSessionId(): string | undefined {
	if (typeof window === "undefined") return undefined
	const now = Date.now()
	const existing = readRecord()
	if (existing && !isExpired(existing, now)) {
		if (now - existing.lastActivityAt > ACTIVITY_TOUCH_THROTTLE_MS) {
			writeRecord({ ...existing, lastActivityAt: now })
		}
		return existing.id
	}
	const record = freshRecord(now)
	writeRecord(record)
	return record.id
}

/** Mark the session as active right now (called as replay chunks flush). */
export function markActivity(): void {
	const record = readRecord()
	if (!record) return
	writeRecord({ ...record, lastActivityAt: Date.now() })
}

/**
 * Take the next replay chunk sequence number for the current session. Monotonic
 * across reloads (persisted on the session record), so a refresh continues the
 * sequence instead of restarting at 0 and overwriting the previous load's blobs.
 */
export function nextChunkSeq(): number {
	const record = readRecord() ?? freshRecord(Date.now())
	const seq = record.chunkSeq
	writeRecord({ ...record, chunkSeq: seq + 1 })
	return seq
}

/**
 * Take the next session-metadata row version for the current session.
 * Monotonic per session across reloads, hide/resume cycles, and writers (both
 * SDKs share the persisted counter), so `argMax(field, Version)` on the
 * backend always resolves to the most recently posted row. Records written by
 * older SDKs (no `metaVersion`) already posted versions 1 and 2, so the
 * counter resumes at 3 for them; a fresh session starts at 1.
 */
export function nextMetaVersion(): number {
	const record = readRecord() ?? freshRecord(Date.now())
	const version = (record.metaVersion ?? 2) + 1
	writeRecord({ ...record, metaVersion: version })
	return version
}
