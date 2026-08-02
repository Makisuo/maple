import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	claimNewVisitor,
	getVisitorId,
	isVisitorIdPersisted,
	resetVisitorCacheForTests,
	setVisitorTracking,
} from "./visitor"

/** Minimal localStorage stand-in; `throwOnWrite` models Safari private mode. */
function installStorage(options: { throwOnWrite?: boolean } = {}): Map<string, string> {
	const store = new Map<string, string>()
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (options.throwOnWrite) throw new Error("QuotaExceededError")
				store.set(key, value)
			},
			removeItem: (key: string) => {
				store.delete(key)
			},
		},
	})
	return store
}

describe("visitor id", () => {
	beforeEach(() => {
		vi.unstubAllGlobals()
		resetVisitorCacheForTests()
	})

	it("mints once and reuses the stored id", () => {
		const store = installStorage()
		const first = getVisitorId()
		expect(first).toBeTruthy()
		expect(claimNewVisitor()).toBe(true)
		// One-shot: a second session started in the same page load (idle rotation)
		// is not a new visitor's session.
		expect(claimNewVisitor()).toBe(false)
		expect(isVisitorIdPersisted()).toBe(true)

		// A later page load reads the stored id rather than minting a new one —
		// that is the whole point of it being a *visitor* id and not a session id.
		resetVisitorCacheForTests()
		expect(getVisitorId()).toBe(first)
		expect(claimNewVisitor()).toBe(false)
		expect(store.size).toBe(1)
	})

	it("expires an id older than 400 days", () => {
		const store = installStorage()
		const stale = Date.now() - 401 * 24 * 60 * 60_000
		store.set("maple.visitor", JSON.stringify({ id: "old-visitor", mintedAt: stale }))

		// Matches the ~13-month ceiling browsers settled on for first-party ids.
		expect(getVisitorId()).not.toBe("old-visitor")
		expect(claimNewVisitor()).toBe(true)
	})

	it("falls back to an in-memory id when storage is blocked, and says so", () => {
		installStorage({ throwOnWrite: true })
		const id = getVisitorId()
		// Still consistent within the page load — better than sending '' — but it
		// is not a real visitor id, so unique counts must be able to discount it.
		expect(id).toBeTruthy()
		expect(getVisitorId()).toBe(id)
		expect(isVisitorIdPersisted()).toBe(false)
	})

	it("opting out purges the stored id, not just future reads", () => {
		const store = installStorage()
		getVisitorId()
		expect(store.size).toBe(1)

		setVisitorTracking(false)
		expect(getVisitorId()).toBeUndefined()
		// An opt-out that leaves the identifier behind is not an opt-out.
		expect(store.size).toBe(0)
	})

	it("returns undefined outside a browser", () => {
		expect(getVisitorId()).toBeUndefined()
	})
})
