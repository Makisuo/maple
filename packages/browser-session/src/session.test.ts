import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getSession, getSessionId, markActivity, nextChunkSeq } from "./session"

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
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-05-22T12:00:00Z"))
	storage = new FakeStorage()
	;(globalThis as { window?: unknown }).window = { sessionStorage: storage }
})

afterEach(() => {
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
