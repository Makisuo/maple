import { clearSessionSink, resetConsentForTests, setConsent, track } from "@maple/browser-session"
import { afterEach, describe, expect, it, vi } from "vitest"

const tracing = vi.hoisted(() => ({ setup: vi.fn(), shutdown: vi.fn(async () => {}) }))
vi.mock("./tracing", () => ({
	setupTracing: (...args: unknown[]) => {
		tracing.setup(...args)
		return tracing.shutdown
	},
}))

// Stands in for the lazily imported rrweb chunk: the point under test is that
// `init` reaches it only through `import()`, not that rrweb records here.
const replay = vi.hoisted(() => ({ start: vi.fn(), shutdown: vi.fn(async () => {}) }))
vi.mock("@maple/browser-session/replay", () => ({
	startReplaySession: (options: unknown) => {
		replay.start(options)
		return { sessionId: "replay-session", shutdown: replay.shutdown }
	},
}))

import { resetSinkForTests } from "../../browser-session/src/events-sink"
import { init } from "./init"

class MemoryStorage {
	private readonly values = new Map<string, string>()
	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value)
	}
	removeItem(key: string): void {
		this.values.delete(key)
	}
}

afterEach(() => {
	setConsent(false)
	resetConsentForTests()
	resetSinkForTests()
	clearSessionSink()
	tracing.setup.mockClear()
	tracing.shutdown.mockClear()
	replay.start.mockClear()
	replay.shutdown.mockClear()
	vi.unstubAllGlobals()
})

const stubBrowser = (): void => {
	vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }))
	vi.stubGlobal("window", {
		sessionStorage: new MemoryStorage(),
		localStorage: new MemoryStorage(),
		location: { href: "https://app.example.com/", host: "app.example.com" },
	})
}

describe("lazy replay chunk", () => {
	it("starts the recorder once the chunk lands and shuts it down on shutdown", async () => {
		stubBrowser()
		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
			replay: { enabled: true, sampleRate: 1 },
		})

		// The sampling decision is synchronous; only the handle arrives late.
		expect(replay.start).not.toHaveBeenCalled()
		expect(handle.sessionId).not.toBe("")
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		expect(handle.sessionId).toBe("replay-session")

		await handle.shutdown()
		expect(replay.shutdown).toHaveBeenCalledWith({ flush: true })
	})

	it("never attaches a recorder when consent is revoked before the chunk lands", async () => {
		setConsent(true)
		stubBrowser()
		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
			replay: { enabled: true, sampleRate: 1 },
			privacy: { requireConsent: true },
		})
		setConsent(false)

		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(replay.start).not.toHaveBeenCalled()

		// A later grant still records — the revoke poisoned that one chunk's
		// callback, not the sampling decision.
		setConsent(true)
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		await handle.shutdown()
	})
})

describe("browser consent lifecycle", () => {
	it("starts on grant, discards revoked buffers, and restarts with a new session", async () => {
		const posts: Array<{ url: string; body: string }> = []
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			posts.push({
				url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				body: typeof init?.body === "string" ? init.body : "",
			})
			return new Response(null, { status: 200 })
		})
		vi.stubGlobal("window", {
			sessionStorage: new MemoryStorage(),
			localStorage: new MemoryStorage(),
			location: { href: "https://app.example.com/", host: "app.example.com" },
		})

		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: true },
			replay: { enabled: false },
			privacy: { requireConsent: true },
		})
		expect(handle.sessionId).toBe("")
		expect(posts).toHaveLength(0)

		setConsent(true)
		await Promise.resolve()
		const firstSessionId = handle.sessionId
		expect(firstSessionId).not.toBe("")
		expect(tracing.setup).toHaveBeenCalledTimes(1)
		track("discard-me")

		setConsent(false)
		expect(handle.sessionId).toBe("")
		setConsent(true)
		await Promise.resolve()
		expect(handle.sessionId).not.toBe(firstSessionId)
		expect(tracing.setup).toHaveBeenCalledTimes(1)
		track("keep-me")
		await handle.shutdown()

		const eventBodies = posts
			.filter((post) => post.url.endsWith("/v1/sessionEvents"))
			.map((post) => post.body)
			.join("\n")
		expect(eventBodies).not.toContain("discard-me")
		expect(eventBodies).toContain("keep-me")
		expect(tracing.shutdown).toHaveBeenCalledTimes(1)
	})
})
