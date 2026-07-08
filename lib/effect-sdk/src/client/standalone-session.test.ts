import { describe, it } from "@effect/vitest"
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
		store.set(
			"maple.session",
			JSON.stringify({ ...stale, lastActivityAt: Date.now() - 31 * 60_000 }),
		)
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
