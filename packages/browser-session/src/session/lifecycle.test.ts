import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { markActivity, noteNavigation, peekSession, rotateSession } from "./session"
import { type SessionLifecycleHooks, type SessionSuspendOptions, startSessionLifecycle } from "./lifecycle"
import { resetVisitorCacheForTests } from "../identity/visitor"

// Same in-memory storage stand-in session.test.ts uses, so the rotation logic
// under test is the real one on a controllable clock.
class FakeStorage {
	private store = new Map<string, string>()
	getItem(key: string): string | null {
		return this.store.has(key) ? this.store.get(key)! : null
	}
	setItem(key: string, value: string): void {
		this.store.set(key, value)
	}
	removeItem(key: string): void {
		this.store.delete(key)
	}
}

type Listener = () => void

class Listeners {
	private readonly byType = new Map<string, Set<Listener>>()
	readonly add = (type: string, fn: Listener): void => {
		let set = this.byType.get(type)
		if (!set) {
			set = new Set()
			this.byType.set(type, set)
		}
		set.add(fn)
	}
	readonly remove = (type: string, fn: Listener): void => {
		this.byType.get(type)?.delete(fn)
	}
	readonly dispatch = (type: string): void => {
		// Set iteration tolerates a handler removing itself mid-dispatch.
		for (const fn of this.byType.get(type) ?? []) fn()
	}
}

const MINUTE = 60_000
const HEARTBEAT = 60_000

interface PostedRow {
	readonly row: Record<string, unknown>
	readonly keepalive: boolean
}

let posted: PostedRow[]
let documentListeners: Listeners
let windowListeners: Listeners
interface MutableDocumentStub {
	visibilityState: string
	addEventListener: Listeners["add"]
	removeEventListener: Listeners["remove"]
}
let doc: MutableDocumentStub

const statuses = (): string[] => posted.map((p) => String(p.row.status))
const last = (): Record<string, unknown> => posted[posted.length - 1]!.row

const start = (hooks: Partial<SessionLifecycleHooks> = {}) =>
	startSessionLifecycle(
		{ serviceName: "web", getTraceIds: () => ["trace-1"] },
		{
			recorded: false,
			post: (row, keepalive) => {
				posted.push({ row, keepalive })
			},
			...hooks,
		},
	)

/** Let the rotation listener's re-arm microtask run. */
const flushMicrotasks = (): Promise<void> => Promise.resolve()

const setVisibility = (state: "visible" | "hidden"): void => {
	doc.visibilityState = state
	documentListeners.dispatch("visibilitychange")
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-05-22T12:00:00Z"))
	posted = []
	documentListeners = new Listeners()
	windowListeners = new Listeners()
	resetVisitorCacheForTests()
	doc = {
		visibilityState: "visible",
		addEventListener: documentListeners.add,
		removeEventListener: documentListeners.remove,
	}
	const globals = globalThis as Record<string, unknown>
	globals.window = { sessionStorage: new FakeStorage(), localStorage: new FakeStorage() }
	globals.document = doc
	globals.addEventListener = windowListeners.add
	globals.removeEventListener = windowListeners.remove
})

afterEach(() => {
	vi.useRealTimers()
	const globals = globalThis as Record<string, unknown>
	delete globals.window
	delete globals.document
	delete globals.addEventListener
	delete globals.removeEventListener
})

describe("startSessionLifecycle", () => {
	it("posts an active row on start and heartbeats while the tab is visible", () => {
		const handle = start()
		expect(handle).toBeDefined()
		expect(statuses()).toEqual(["active"])
		expect(last().version).toBe(1)
		expect(last().session_id).toBe(handle!.sessionId)

		vi.advanceTimersByTime(2 * HEARTBEAT)
		expect(statuses()).toEqual(["active", "active", "active"])
		expect(last().version).toBe(3)
	})

	it("skips the heartbeat while the tab is hidden", () => {
		start()
		// Not a visibilitychange — a tab that was already hidden, or one whose
		// hide handler already ran.
		doc.visibilityState = "hidden"
		vi.advanceTimersByTime(5 * HEARTBEAT)
		expect(statuses()).toEqual(["active"])
	})
})

describe("idle expiry", () => {
	it("ends the session from the heartbeat instead of keeping an abandoned tab active", () => {
		start()
		vi.advanceTimersByTime(31 * MINUTE)

		// One `ended`, at the first heartbeat past the 30-minute idle window, and
		// nothing after it: heartbeating on would stretch an abandoned tab into an
		// hours-long session measured in wall-clock rather than active time.
		expect(statuses().filter((s) => s === "ended")).toHaveLength(1)
		expect(statuses()[statuses().length - 1]).toBe("ended")
		expect(last().end_time).toBeDefined()

		const afterEnd = posted.length
		vi.advanceTimersByTime(10 * MINUTE)
		expect(posted).toHaveLength(afterEnd)
	})

	it("keeps heartbeating a session that activity is keeping alive", () => {
		start()
		// 40 minutes of use in 5-minute steps: past the idle window in total, never
		// idle for it. Expiry is judged on the persisted record, so the activity
		// bumps have to be visible to the heartbeat.
		for (let i = 0; i < 8; i++) {
			vi.advanceTimersByTime(5 * MINUTE)
			markActivity()
		}
		expect(statuses()).not.toContain("ended")
		expect(posted).toHaveLength(1 + 40)
	})

	it("wakes back up when a rotation replaces the expired session", async () => {
		const onSessionChange = vi.fn()
		const handle = start({ onSessionChange })
		const first = handle!.sessionId

		vi.advanceTimersByTime(31 * MINUTE)
		expect(statuses()[statuses().length - 1]).toBe("ended")

		// Real activity resolves the session, which rotates it — and the dormant
		// lifecycle re-arms under the new id.
		markActivity()
		await flushMicrotasks()

		expect(onSessionChange).toHaveBeenCalledTimes(1)
		expect(handle!.sessionId).not.toBe(first)
		expect(last().status).toBe("active")
		expect(last().session_id).toBe(handle!.sessionId)
		expect(last().version).toBe(1)
	})
})

describe("idle rotation", () => {
	it("ends the outgoing session and starts the incoming one", async () => {
		const onSessionChange = vi.fn()
		const onStart = vi.fn()
		const handle = start({ onSessionChange, onStart })
		const first = handle!.sessionId
		posted = []

		rotateSession()
		// The `ended` row is posted synchronously, under the outgoing id.
		expect(statuses()).toEqual(["ended"])
		expect(last().session_id).toBe(first)
		expect(last().trace_ids).toEqual(["trace-1"])

		await flushMicrotasks()
		expect(statuses()).toEqual(["ended", "active"])
		expect(last().session_id).toBe(handle!.sessionId)
		expect(handle!.sessionId).not.toBe(first)
		expect(onSessionChange).toHaveBeenCalledWith(handle!.sessionId)
		// Capture restarts under the new record, not the replaced one.
		expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ id: handle!.sessionId }))
	})
})

describe("visibility", () => {
	it("ends on hide with keepalive and resumes with a fresh active row", () => {
		const suspends: SessionSuspendOptions[] = []
		const onStart = vi.fn()
		start({ onStart, onSuspend: (options) => void suspends.push(options) })
		expect(onStart).toHaveBeenCalledTimes(1)

		setVisibility("hidden")
		expect(statuses()).toEqual(["active", "ended"])
		expect(posted[1]!.keepalive).toBe(true)
		expect(suspends).toEqual([{ flush: true, keepalive: true }])

		// A second hide signal (pagehide after visibilitychange) must not post again.
		windowListeners.dispatch("pagehide")
		expect(statuses()).toEqual(["active", "ended"])

		setVisibility("visible")
		expect(statuses()).toEqual(["active", "ended", "active"])
		expect(onStart).toHaveBeenCalledTimes(2)
	})

	it("does not resume an expired session — it rotates instead", async () => {
		const handle = start()
		const first = handle!.sessionId
		setVisibility("hidden")
		vi.advanceTimersByTime(31 * MINUTE)
		posted = []

		setVisibility("visible")
		await flushMicrotasks()

		expect(statuses()).toEqual(["active"])
		expect(handle!.sessionId).not.toBe(first)
		expect(last().session_id).toBe(handle!.sessionId)
	})

	it("posts an ended row with observed trace ids on pagehide", () => {
		start()
		windowListeners.dispatch("pagehide")
		expect(statuses()).toEqual(["active", "ended"])
		expect(last().trace_ids).toEqual(["trace-1"])
		expect(last().duration_ms).toBe(0)
	})
})

describe("row contents", () => {
	it("reports the live exit path and page view count, not the session's first page", () => {
		start()
		expect(last().page_views).toBe(0)

		noteNavigation("https://app.example/pricing")
		noteNavigation("https://app.example/docs")
		vi.advanceTimersByTime(HEARTBEAT)

		expect(last().status).toBe("active")
		expect(last().exit_path).toBe("/docs")
		expect(last().page_views).toBe(2)
	})

	it("carries the owner's click tally across a suspend without double counting", () => {
		let clicks = 0
		start({ clicksSinceStart: () => clicks })

		clicks = 3
		setVisibility("hidden")
		expect(last().click_count).toBe(3)
		// Written back to the record, which is what survives the suspend.
		expect(peekSession()?.clickCount).toBe(3)

		// Capture restarts from zero on resume; the persisted total is the base.
		clicks = 0
		setVisibility("visible")
		expect(last().click_count).toBe(3)
		clicks = 2
		vi.advanceTimersByTime(HEARTBEAT)
		expect(last().click_count).toBe(5)
	})
})

describe("shutdown", () => {
	it("posts a final ended row and stops the heartbeat", async () => {
		const handle = start()
		await handle!.shutdown()
		expect(statuses()).toEqual(["active", "ended"])
		expect(posted[1]!.keepalive).toBe(true)

		vi.advanceTimersByTime(5 * HEARTBEAT)
		expect(posted).toHaveLength(2)
	})

	it("detaches without posting when told not to flush (consent revoke)", async () => {
		const suspends: SessionSuspendOptions[] = []
		const handle = start({ onSuspend: (options) => void suspends.push(options) })
		await handle!.shutdown({ flush: false })

		expect(statuses()).toEqual(["active"])
		expect(suspends).toEqual([{ flush: false, keepalive: false }])
		// Listeners are gone: a late hide signal cannot revive the lifecycle.
		windowListeners.dispatch("pagehide")
		expect(statuses()).toEqual(["active"])
	})

	it("awaits the owner's flush", async () => {
		let flushed = false
		const handle = start({
			onSuspend: async () => {
				await Promise.resolve()
				flushed = true
			},
		})
		await handle!.shutdown()
		expect(flushed).toBe(true)
	})
})
