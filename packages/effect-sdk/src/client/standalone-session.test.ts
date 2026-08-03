import { describe, it } from "@effect/vitest"
import { getActiveSink } from "@maple/browser-session"
import { Effect } from "effect"
import { afterEach, beforeEach, expect, vi } from "vitest"
import { make } from "./flushable.js"
import { resetStandaloneSessionForTests } from "./standalone-session.js"
import { identify } from "./user.js"

// Sessions-UI emission for the standalone Effect client: `make()` must post
// `/v1/sessionReplays/meta` rows (active on setup, ended with observed trace
// ids on tab-hide) when no `@maple-dev/browser` sink is on the page.

interface MetaPost {
	readonly url: string
	readonly row: Record<string, any>
	readonly keepalive: boolean | undefined
}

const setupFetch = () => {
	const metaPosts: Array<MetaPost> = []
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url.includes("/v1/sessionReplays/meta") && typeof init?.body === "string") {
			metaPosts.push({ url, row: JSON.parse(init.body.trim()), keepalive: init?.keepalive })
		}
		return new Response(null, { status: 200 })
	}) as typeof fetch
	return { metaPosts, restore: () => void (globalThis.fetch = original) }
}

const stubWindow = () => {
	const store = new Map<string, string>()
	vi.stubGlobal("window", {
		sessionStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		},
		location: { href: "https://app.example.com/dashboard" },
	})
	return store
}

const baseConfig = {
	serviceName: "unit-test",
	endpoint: "https://collector.test",
	ingestKey: "secret",
	environment: "test",
	serviceVersion: "abc123",
	autoFlushInterval: false as const,
	flushOnUnload: false as const,
}

describe("standalone session emission (client)", () => {
	let restore: () => void

	beforeEach(() => {
		resetStandaloneSessionForTests()
	})

	afterEach(() => {
		identify(undefined)
		restore?.()
		vi.unstubAllGlobals()
	})

	it("posts an active session row on make() with the stored session id", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r
		const store = stubWindow()

		make(baseConfig)

		// postSessionMetaRow is fire-and-forget; let the microtask run.
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(metaPosts.length).toBe(1)
		const row = metaPosts[0].row
		const stored = JSON.parse(store.get("maple.session")!)
		expect(row.session_id).toBe(stored.id)
		expect(row.status).toBe("active")
		expect(row.version).toBe(1)
		expect(row.service_name).toBe("unit-test")
		expect(row.url_initial).toBe("https://app.example.com/dashboard")
		expect(row.resource_attributes["deployment.environment"]).toBe("test")
		expect(row.resource_attributes["deployment.commit_sha"]).toBe("abc123")
		// This path posts metadata only — no rrweb chunks follow it. The marker is
		// what lets the Sessions UI say "not recorded" instead of rendering a
		// player over nothing.
		expect(row.resource_attributes["maple.session.recorded"]).toBe("false")
	})

	it("normalizes cleared identity to an anonymous session row", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r
		stubWindow()
		identify("user_to_clear")
		identify(undefined)

		make(baseConfig)

		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(metaPosts[0].row.user_id).toBe("")
	})

	it("keeps persisted click/error totals and adds live capture deltas", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r
		const store = stubWindow()
		store.set(
			"maple.session",
			JSON.stringify({
				id: "persisted-session",
				startedAt: Date.now(),
				lastActivityAt: Date.now(),
				chunkSeq: 0,
				metaVersion: 0,
				visitorIsNew: false,
				clickCount: 7,
				errorCount: 3,
				pageViews: 2,
			}),
		)

		const telemetry = make(baseConfig)
		await new Promise((resolve) => setTimeout(resolve, 0))
		const active = metaPosts.find((post) => post.row.session_id === "persisted-session")!
		expect(active.row.click_count).toBe(7)
		expect(active.row.error_count).toBe(3)

		getActiveSink()?.emit({ type: "click" })
		getActiveSink()?.emit({ type: "error", message: "boom" })
		await telemetry.dispose()
		await new Promise((resolve) => setTimeout(resolve, 0))

		const ended = metaPosts.filter((post) => post.row.status === "ended").at(-1)!
		expect(ended.row.click_count).toBe(8)
		expect(ended.row.error_count).toBe(4)
	})

	// Two client runtimes overlap on a page whenever a runtime is rebuilt before
	// the outgoing one's async release finishes — React StrictMode double-mounts
	// and HMR remounts both do it. The metadata session is a page-level
	// singleton, so both runtimes end up holding it: tearing the first one down
	// must not end the session the second is still using.
	it("keeps the session alive while a second client runtime still holds it", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r
		stubWindow()

		const first = make(baseConfig)
		const second = make(baseConfig)
		await new Promise((resolve) => setTimeout(resolve, 0))
		// One shared session, not one per runtime.
		expect(metaPosts.filter((post) => post.row.status === "active").length).toBe(1)

		await first.dispose()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(metaPosts.filter((post) => post.row.status === "ended").length).toBe(0)

		await second.dispose()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(metaPosts.filter((post) => post.row.status === "ended").length).toBe(1)
	})

	it("treats a repeated dispose of the same runtime as a no-op", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r
		stubWindow()

		const telemetry = make(baseConfig)
		await new Promise((resolve) => setTimeout(resolve, 0))
		await telemetry.dispose()
		await telemetry.dispose()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(metaPosts.filter((post) => post.row.status === "ended").length).toBe(1)
	})

	it("posts nothing when the @maple-dev/browser sink owns the session", async () => {
		const { metaPosts, restore: rf } = setupFetch()
		const g = globalThis as Record<string, any>
		g.__MAPLE_BROWSER_SESSION__ = { sessionId: "sess-1", recordTraceId: () => {} }
		restore = () => {
			rf()
			delete g.__MAPLE_BROWSER_SESSION__
		}
		stubWindow()

		make(baseConfig)

		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(metaPosts.length).toBe(0)
	})

	it("posts nothing during SSR or without an ingest key", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r

		make(baseConfig) // node: no window

		stubWindow()
		make({ ...baseConfig, ingestKey: undefined }) // window but no key

		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(metaPosts.length).toBe(0)
	})

	it("attaches observed trace ids to the ended row and rotates sessions", async () => {
		const { metaPosts, restore: r } = setupFetch()
		restore = r
		const store = stubWindow()

		const telemetry = make(baseConfig)
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		const firstSession = JSON.parse(store.get("maple.session")!).id

		// Expire the session, then emit another span: the old session must get an
		// ended row carrying the first span's trace id, the new one an active row.
		const stale = JSON.parse(store.get("maple.session")!)
		store.set("maple.session", JSON.stringify({ ...stale, lastActivityAt: Date.now() - 31 * 60_000 }))
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-2"), Effect.provide(telemetry.layer)),
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		const ended = metaPosts.find((p) => p.row.status === "ended")
		expect(ended).toBeDefined()
		expect(ended!.row.session_id).toBe(firstSession)
		expect(ended!.row.trace_ids.length).toBe(1)
		expect(ended!.row.trace_ids[0]).toMatch(/^[0-9a-f]{32}$/i)

		const secondActive = metaPosts.filter((p) => p.row.status === "active").at(-1)!
		expect(secondActive.row.session_id).not.toBe(firstSession)
		expect(secondActive.row.session_id).toBe(JSON.parse(store.get("maple.session")!).id)
	})
})
