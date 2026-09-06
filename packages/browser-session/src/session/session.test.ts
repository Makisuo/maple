import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	getSession,
	getSessionId,
	isNewVisitorSession,
	markActivity,
	nextChunkSeq,
	nextMetaVersion,
	onSessionRotate,
	peekSession,
} from "./session"
import { resetVisitorCacheForTests } from "../identity/visitor"

// Minimal in-memory sessionStorage standing in for the browser's, so the
// rotation logic can be exercised under Node with a controllable clock.
class FakeStorage {
	private store = new Map<string, string>()
	getItem(key: string): string | null {
		return this.store.has(key) ? this.store.get(key)! : null
	}
	setItem(key: string, value: string): void {
		this.store.set(key, value)
	}
	clear(): void {
		this.store.clear()
	}
}

const MINUTE = 60_000
const STORAGE_KEY = "maple.session"

let storage: FakeStorage

beforeEach(() => {
	vi.stubGlobal("document", {})
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-05-22T12:00:00Z"))
	storage = new FakeStorage()
	resetVisitorCacheForTests()
	;(globalThis as { window?: unknown }).window = {
		sessionStorage: storage,
		localStorage: new FakeStorage(),
	}
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
	delete (globalThis as { window?: unknown }).window
})

describe("getSession", () => {
	it("mints a fresh session on first call", () => {
		const s = getSession()
		expect(s.id).toMatch(/[0-9a-f-]{36}/)
		expect(s.chunkSeq).toBe(0)
		expect(s.startedAt).toBe(Date.now())
		expect(s.lastActivityAt).toBe(Date.now())
	})

	it("reuses the session across reloads within the idle window", () => {
		const first = getSession()
		vi.advanceTimersByTime(10 * MINUTE)
		const second = getSession()
		expect(second.id).toBe(first.id)
		// startedAt is stable so duration_ms reflects the whole session.
		expect(second.startedAt).toBe(first.startedAt)
		// lastActivityAt advances to keep the live session alive.
		expect(second.lastActivityAt).toBe(Date.now())
	})

	it("rotates to a new session after >30min idle", () => {
		const first = getSession()
		vi.advanceTimersByTime(31 * MINUTE)
		const second = getSession()
		expect(second.id).not.toBe(first.id)
		expect(second.chunkSeq).toBe(0)
		expect(second.startedAt).toBe(Date.now())
	})

	it("notifies rotation listeners before installing the replacement record", () => {
		const first = getSession()
		const rotations: Array<[string, string, string | undefined]> = []
		const stop = onSessionRotate((previous, next) => {
			rotations.push([previous.id, next.id, peekSession()?.id])
		})
		vi.advanceTimersByTime(31 * MINUTE)
		const second = getSession()
		stop()

		expect(rotations).toEqual([[first.id, second.id, first.id]])
	})

	it("rotates once the session passes the 24h lifetime cap", () => {
		const first = getSession()
		// Stay active every 10 min for just over 24h so idle never triggers — only the cap.
		for (let elapsed = 0; elapsed <= 25 * 60 * MINUTE; elapsed += 10 * MINUTE) {
			vi.advanceTimersByTime(10 * MINUTE)
			getSession()
		}
		const latest = getSession()
		expect(latest.id).not.toBe(first.id)
	})

	it("ignores a corrupt stored record and mints fresh", () => {
		storage.setItem(STORAGE_KEY, "{not json")
		const s = getSession()
		expect(s.id).toMatch(/[0-9a-f-]{36}/)
		storage.setItem(STORAGE_KEY, JSON.stringify({ id: "x", startedAt: Date.now() }))
		const rotated = getSession()
		expect(rotated.id).not.toBe("x")
	})
})

describe("getSessionId", () => {
	it("returns undefined when window exists without a document (React Native)", () => {
		vi.stubGlobal("document", undefined)
		vi.stubGlobal("crypto", undefined)
		expect(getSessionId()).toBeUndefined()
		expect(storage.getItem(STORAGE_KEY)).toBeNull()
	})

	it("returns undefined outside a browser (SSR)", () => {
		delete (globalThis as { window?: unknown }).window
		expect(getSessionId()).toBeUndefined()
	})

	it("mints and persists a session standalone", () => {
		const id = getSessionId()
		expect(id).toMatch(/[0-9a-f-]{36}/)
		const stored = JSON.parse(storage.getItem(STORAGE_KEY)!)
		expect(stored.id).toBe(id)
		expect(stored.chunkSeq).toBe(0)
	})

	it("reuses a record written by getSession (browser SDK path) and preserves chunkSeq", () => {
		const s = getSession()
		nextChunkSeq()
		nextChunkSeq()
		vi.advanceTimersByTime(5 * MINUTE)
		expect(getSessionId()).toBe(s.id)
		const stored = JSON.parse(storage.getItem(STORAGE_KEY)!)
		expect(stored.chunkSeq).toBe(2)
	})

	it("is accepted back by getSession (effect SDK wrote first)", () => {
		const id = getSessionId()
		vi.advanceTimersByTime(5 * MINUTE)
		const s = getSession()
		expect(s.id).toBe(id)
		expect(nextChunkSeq()).toBe(0)
	})

	it("throttles the activity touch-write under 5s", () => {
		const id = getSessionId()
		const before = storage.getItem(STORAGE_KEY)
		vi.advanceTimersByTime(3_000)
		expect(getSessionId()).toBe(id)
		expect(storage.getItem(STORAGE_KEY)).toBe(before) // no write
		vi.advanceTimersByTime(3_000) // 6s since last persisted activity
		expect(getSessionId()).toBe(id)
		expect(storage.getItem(STORAGE_KEY)).not.toBe(before)
	})

	it("keeps a session alive through span activity that getSession would have rotated", () => {
		const id = getSessionId()
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(20 * MINUTE)
			expect(getSessionId()).toBe(id)
		}
	})

	it("rotates after idle timeout", () => {
		const id = getSessionId()
		vi.advanceTimersByTime(31 * MINUTE)
		expect(getSessionId()).not.toBe(id)
	})

	it("falls back to an ephemeral session when storage throws (private mode)", () => {
		;(globalThis as { window?: unknown }).window = {
			sessionStorage: {
				getItem() {
					throw new Error("denied")
				},
				setItem() {
					throw new Error("denied")
				},
			},
		}
		const id = getSessionId()
		expect(id).toMatch(/[0-9a-f-]{36}/)
		expect(getSessionId()).toBe(id)
	})
})

describe("nextChunkSeq", () => {
	it("is monotonic and continues across a reload within the window", () => {
		getSession()
		expect(nextChunkSeq()).toBe(0)
		expect(nextChunkSeq()).toBe(1)
		expect(nextChunkSeq()).toBe(2)

		// Reload within the window: seq must continue, not restart at 0.
		vi.advanceTimersByTime(5 * MINUTE)
		const reused = getSession()
		expect(reused.chunkSeq).toBe(3)
		expect(nextChunkSeq()).toBe(3)
		expect(nextChunkSeq()).toBe(4)
	})

	it("restarts at 0 for a rotated session", () => {
		getSession()
		nextChunkSeq()
		nextChunkSeq()
		vi.advanceTimersByTime(31 * MINUTE)
		getSession() // rotates
		expect(nextChunkSeq()).toBe(0)
	})
})

describe("nextMetaVersion", () => {
	it("starts at 1 for a fresh session and increments monotonically", () => {
		getSession()
		expect(nextMetaVersion()).toBe(1)
		expect(nextMetaVersion()).toBe(2)
		expect(nextMetaVersion()).toBe(3)
	})

	it("resumes at 3 for a legacy record without the counter (v1 active + v2 ended already posted)", () => {
		storage.setItem(
			STORAGE_KEY,
			JSON.stringify({ id: "legacy", startedAt: Date.now(), lastActivityAt: Date.now(), chunkSeq: 5 }),
		)
		expect(nextMetaVersion()).toBe(3)
		expect(nextMetaVersion()).toBe(4)
	})

	it("survives a reload within the window and restarts for a rotated session", () => {
		getSession()
		nextMetaVersion() // 1
		nextMetaVersion() // 2
		vi.advanceTimersByTime(5 * MINUTE)
		getSession() // reload within window keeps the counter
		expect(nextMetaVersion()).toBe(3)
		vi.advanceTimersByTime(31 * MINUTE)
		getSession() // rotation resets it
		expect(nextMetaVersion()).toBe(1)
	})
})

describe("markActivity", () => {
	it("pushes back the idle deadline so a session is not rotated", () => {
		const first = getSession()
		vi.advanceTimersByTime(20 * MINUTE)
		markActivity()
		vi.advanceTimersByTime(20 * MINUTE) // 40min since start, but only 20min since activity
		const second = getSession()
		expect(second.id).toBe(first.id)
	})
})

describe("new-visitor attribution", () => {
	it("survives a reload, because the winning metadata row is the last one written", () => {
		const first = getSession()
		expect(first.visitorIsNew).toBe(true)
		expect(isNewVisitorSession()).toBe(true)

		// A reload clears the in-memory "minted just now" flag but keeps the
		// session. Re-deriving it here would post `visitor_is_new = 0` at a higher
		// Version, and ReplacingMergeTree would keep *that* row — turning every
		// new visitor who refreshes into a returning one.
		resetVisitorCacheForTests()
		expect(getSession().id).toBe(first.id)
		expect(isNewVisitorSession()).toBe(true)
	})

	it("does not mark the session a visitor rotates into as new", () => {
		expect(getSession().visitorIsNew).toBe(true)
		vi.advanceTimersByTime(31 * MINUTE)
		// Same visitor, new session: the id was not minted for it.
		expect(getSession().visitorIsNew).toBe(false)
		expect(isNewVisitorSession()).toBe(false)
	})

	it("migrates a legacy in-flight session and consumes the new-visitor claim", () => {
		storage.setItem(
			STORAGE_KEY,
			JSON.stringify({ id: "old", startedAt: Date.now(), lastActivityAt: Date.now(), chunkSeq: 0 }),
		)
		expect(isNewVisitorSession()).toBe(true)
		expect(JSON.parse(storage.getItem(STORAGE_KEY)!).visitorIsNew).toBe(true)

		vi.advanceTimersByTime(31 * MINUTE)
		expect(getSession().visitorIsNew).toBe(false)
	})
})

// The record validator was an `effect/Schema` decoder until it became the
// single largest item in the browser SDK's page-load budget. These pin the
// semantics that replaced it, since records written by the old decoder are
// still out there in real sessionStorage.
//
// Every fixture carries its own id, deliberately: a rejected record falls back
// to the module's in-memory `ephemeral` copy, which outlives a test, so a
// shared id would let a previous test's session masquerade as this one's.
describe("stored record validation", () => {
	const base = (id: string) => ({
		id,
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		chunkSeq: 3,
	})
	const store = (record: unknown): void => storage.setItem(STORAGE_KEY, JSON.stringify(record))

	it("accepts a minimal record written by an older SDK", () => {
		store(base("sess-minimal"))
		expect(getSession().id).toBe("sess-minimal")
	})

	it("accepts a record carrying every optional field", () => {
		store({
			...base("sess-full"),
			metaVersion: 4,
			entryUrl: "https://acme.test/pricing",
			entryReferrer: "https://news.test",
			utm: { utm_source: "hn" },
			visitorIsNew: true,
			lastUrl: "https://acme.test/checkout",
			pageViews: 2,
			clickCount: 7,
			errorCount: 1,
		})
		const session = getSession()
		expect(session.id).toBe("sess-full")
		expect(session.metaVersion).toBe(4)
		expect(session.utm).toEqual({ utm_source: "hn" })
		expect(session.visitorIsNew).toBe(true)
	})

	it.each([
		["a required field of the wrong type", { ...base("sess-bad"), chunkSeq: "3" }],
		["an optional number of the wrong type", { ...base("sess-bad"), pageViews: "2" }],
		["an optional string of the wrong type", { ...base("sess-bad"), entryUrl: 404 }],
		["an optional boolean of the wrong type", { ...base("sess-bad"), visitorIsNew: "yes" }],
		["a utm map with a non-string value", { ...base("sess-bad"), utm: { utm_source: 5 } }],
		// `null` is not an accepted stand-in for absent — `Schema.optionalKey`
		// rejected it too, and a null here means something wrote a shape we do
		// not understand.
		["a null in place of an absent optional", { ...base("sess-bad"), metaVersion: null }],
		["a JSON array rather than an object", [base("sess-bad")]],
		["a JSON scalar rather than an object", "sess-bad"],
	])("rejects %s rather than adopting it", (_label, record) => {
		store(record)
		expect(getSession().id).not.toBe("sess-bad")
	})

	it("drops an unknown key written by a newer SDK rather than carrying it", () => {
		store({ ...base("sess-future"), somethingFromTheFuture: "keep-out" })
		const session = getSession()
		expect(session.id).toBe("sess-future")
		expect(session).not.toHaveProperty("somethingFromTheFuture")
	})
})
