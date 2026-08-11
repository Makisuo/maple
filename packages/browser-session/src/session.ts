import { claimNewVisitor } from "./visitor"

const STORAGE_KEY = "maple.session"

/** Rotate the session after this much inactivity (PostHog's default). */
const IDLE_TIMEOUT_MS = 30 * 60_000
/** Hard cap on a single session's lifetime regardless of activity. */
const MAX_SESSION_MS = 24 * 60 * 60_000
/**
 * The activity path runs per span creation (`getSessionId`) and per captured
 * event (`markActivity` — every console call, keystroke, click, fetch);
 * persisting the bump on every call would hammer sessionStorage for no benefit
 * — rotation correctness only needs sub-idle-timeout granularity.
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

	// All optional: `readRecord`'s validator deliberately still accepts records
	// written by older SDKs, which have none of these.
	//
	// Entry fields are captured once, in `freshRecord`, and then never change —
	// so they are identical on every metadata row version, which matters because
	// ReplacingMergeTree replaces the whole row rather than merging fields.

	/** Full URL of the first page of this session. */
	entryUrl?: string
	/** `document.referrer` as seen on that first page. */
	entryReferrer?: string
	/** utm_* query params from the entry URL. */
	utm?: Record<string, string>
	/**
	 * Whether the visitor id was minted when this session started.
	 *
	 * Persisted rather than re-derived per metadata row because "new" is a fact
	 * about the session, not about the page load: the flag lives in memory, a
	 * reload clears it, and the backend is a ReplacingMergeTree that keeps the
	 * *latest* row wholesale — so a re-derived value would silently rewrite a
	 * new visitor's session into a returning one on the first refresh.
	 */
	visitorIsNew?: boolean
	/** Most recent URL seen — becomes `exit_path`. */
	lastUrl?: string
	/** Navigations seen this session. `<= 1` is a bounce. */
	pageViews?: number
	clickCount?: number
	errorCount?: number
}

/** The immutable acquisition context of a session. */
export interface EntryContext {
	readonly entryUrl: string
	readonly referrer: string
	readonly utm: Record<string, string>
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const

/** In-memory fallback when sessionStorage is unavailable (private mode). */
let ephemeral: SessionRecord | undefined

export type SessionRotationListener = (previous: SessionRecord, next: SessionRecord) => void
const rotationListeners = new Set<SessionRotationListener>()

/**
 * Read the entry URL/referrer/UTM of the current page.
 *
 * Guarded for non-DOM runtimes: `freshRecord` is reachable from `getSessionId`
 * on the span path and from the `nextChunkSeq`/`nextMetaVersion` fallbacks, so
 * this must not assume `location`/`document` exist.
 */
function readEntryContext(): Partial<SessionRecord> {
	if (typeof window === "undefined" || typeof location === "undefined") return {}
	const utm: Record<string, string> = {}
	try {
		const params = new URLSearchParams(location.search)
		for (const key of UTM_KEYS) {
			const value = params.get(key)?.trim()
			// Bounded because UtmSource/Medium/Campaign are LowCardinality columns.
			if (value) utm[key] = value.slice(0, 128)
		}
	} catch {
		// Malformed query string — no UTM, not a failure.
	}
	return {
		entryUrl: location.href,
		entryReferrer: typeof document !== "undefined" ? document.referrer : "",
		utm,
		lastUrl: location.href,
		pageViews: 0,
		clickCount: 0,
		errorCount: 0,
	}
}

function freshRecord(now: number): SessionRecord {
	return {
		id: crypto.randomUUID(),
		startedAt: now,
		lastActivityAt: now,
		chunkSeq: 0,
		metaVersion: 0,
		// Claimed once, at session creation, so exactly one session per minted
		// visitor id is the "new visitor" one — and so a reload, which re-derives
		// nothing, cannot downgrade it.
		visitorIsNew: claimNewVisitor(),
		...readEntryContext(),
	}
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

export function isSessionExpired(record: SessionRecord, now = Date.now()): boolean {
	return now - record.lastActivityAt > IDLE_TIMEOUT_MS || now - record.startedAt > MAX_SESSION_MS
}

/** Observe genuine idle/lifetime rotation. Invoked before the new record is installed. */
export function onSessionRotate(listener: SessionRotationListener): () => void {
	rotationListeners.add(listener)
	return () => rotationListeners.delete(listener)
}

/**
 * Upgrade an in-flight session written by an older SDK. The visitor feature
 * can land while a tab still has the old record in sessionStorage; claiming
 * newness here makes that current session the new visitor's session and
 * consumes the one-shot claim so a later idle rotation cannot steal it.
 */
function migrateRecord(record: SessionRecord): SessionRecord {
	return record.visitorIsNew === undefined ? { ...record, visitorIsNew: claimNewVisitor() } : record
}

function installRotatedRecord(previous: SessionRecord | undefined, next: SessionRecord): void {
	if (previous) {
		for (const listener of rotationListeners) {
			try {
				listener(previous, next)
			} catch {
				// Rotation is storage-critical. A lifecycle observer must not keep an
				// expired id alive or prevent the other owners from rotating with it.
			}
		}
	}
	writeRecord(next)
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
	if (existing && !isSessionExpired(existing, now)) {
		const record = { ...migrateRecord(existing), lastActivityAt: now }
		writeRecord(record)
		return record
	}
	const record = freshRecord(now)
	installRotatedRecord(existing, record)
	return record
}

/** Force a new session boundary (used after a consent revoke/re-grant cycle). */
export function rotateSession(): SessionRecord | undefined {
	if (typeof window === "undefined") return undefined
	const previous = readRecord()
	const next = freshRecord(Date.now())
	installRotatedRecord(previous, next)
	return next
}

/**
 * Resolve the active session, rotating when the stored one has expired, and
 * persist the activity bump only once it has gone stale by
 * `ACTIVITY_TOUCH_THROTTLE_MS`. Shared by the two hot-path entry points so a
 * chatty page doesn't pay a sessionStorage read *and* write per span/event.
 */
function touchSession(now: number): SessionRecord {
	const existing = readRecord()
	if (existing && !isSessionExpired(existing, now)) {
		const migrated = migrateRecord(existing)
		const touched = { ...migrated, lastActivityAt: now }
		if (migrated !== existing || now - existing.lastActivityAt > ACTIVITY_TOUCH_THROTTLE_MS) {
			writeRecord(touched)
		}
		return touched
	}
	const record = freshRecord(now)
	installRotatedRecord(existing, record)
	return record
}

/**
 * Resolve the active session id, minting/rotating as needed. Safe to call per
 * span: the activity touch is throttled. Returns `undefined` outside a browser
 * (SSR) so server renders never mint a session shared across requests.
 */
export function getSessionId(): string | undefined {
	if (typeof window === "undefined") return undefined
	return touchSession(Date.now()).id
}

/**
 * Mark activity, rotating first when the stored session has expired. Called per
 * captured event, so it shares `getSessionId`'s throttled touch — callers read
 * the returned record's `id` to detect that rotation.
 */
export function markActivity(): SessionRecord | undefined {
	if (typeof window === "undefined") return undefined
	return touchSession(Date.now())
}

/**
 * Record a page view. Persisted on the session record rather than held in the
 * capture loop's memory so the count survives reloads within the session — a
 * two-page visit split by a refresh is not a bounce.
 */
export function noteNavigation(url: string): void {
	if (typeof window === "undefined") return
	const now = Date.now()
	const record = touchSession(now)
	writeRecord({
		...record,
		lastUrl: url,
		pageViews: (record.pageViews ?? 0) + 1,
		lastActivityAt: now,
	})
}

/** Accumulate interaction/error counts onto the persisted session record. */
export function noteCounts(counts: { clickCount?: number; errorCount?: number }): void {
	const record = readRecord()
	if (!record) return
	writeRecord({
		...record,
		clickCount: counts.clickCount ?? record.clickCount ?? 0,
		errorCount: counts.errorCount ?? record.errorCount ?? 0,
	})
}

/**
 * The persisted session record as-is — no activity touch, no rotation. Use
 * this to read counters when posting a metadata row; `getSession()` would
 * rotate an idle session out from under the row being written.
 */
export function peekSession(): SessionRecord | undefined {
	return readRecord()
}

/**
 * Whether the current session belongs to a first-time visitor. Read off the
 * persisted record, so every metadata row of a session answers identically no
 * matter how many reloads or heartbeats it spans.
 */
export function isNewVisitorSession(): boolean {
	const record = readRecord()
	if (!record) return false
	const migrated = migrateRecord(record)
	if (migrated !== record) writeRecord(migrated)
	return migrated.visitorIsNew === true
}

/**
 * The acquisition context carried by a record. Takes the record rather than
 * re-reading storage, because every caller already holds one — the metadata
 * lifecycle posts from it.
 */
export function entryContextOf(record: SessionRecord): EntryContext {
	return {
		entryUrl: record.entryUrl ?? "",
		referrer: record.entryReferrer ?? "",
		utm: record.utm ?? {},
	}
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
