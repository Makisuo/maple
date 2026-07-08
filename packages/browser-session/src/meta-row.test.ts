import { afterEach, describe, expect, it, vi } from "vitest"
import { buildSessionMetaRow, postSessionMetaRow } from "./meta-row"

// The ingest key is auth only: `postSessionMetaRow` attaches the `Authorization`
// header when a key is set, and omits it when unset so a proxy/gateway can add
// it — the row still posts either way.

interface Captured {
	readonly url: string
	readonly authorization: string | null
	readonly contentType: string | null
}

const setupFetch = () => {
	const calls: Array<Captured> = []
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const headers = new Headers(init?.headers)
		calls.push({
			url,
			authorization: headers.get("authorization"),
			contentType: headers.get("content-type"),
		})
		return new Response(null, { status: 200 })
	}) as typeof fetch
	return { calls, restore: () => void (globalThis.fetch = original) }
}

const row = () =>
	buildSessionMetaRow({
		sessionId: "sess-1",
		startedAt: new Date("2026-05-22T12:00:00Z"),
		version: 1,
		status: "active",
		serviceName: "unit-test",
	})

describe("postSessionMetaRow auth header", () => {
	let restore: () => void
	afterEach(() => {
		restore?.()
		vi.unstubAllGlobals()
	})

	it("attaches Authorization when an ingest key is set", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r

		await postSessionMetaRow("https://collector.test", "secret", row())

		expect(calls.length).toBe(1)
		expect(calls[0].url).toBe("https://collector.test/v1/sessionReplays/meta")
		expect(calls[0].authorization).toBe("Bearer secret")
		expect(calls[0].contentType).toBe("application/x-ndjson")
	})

	it("omits Authorization when no ingest key is set (proxy attaches it)", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r

		await postSessionMetaRow("https://collector.test", undefined, row())

		expect(calls.length).toBe(1)
		expect(calls[0].authorization).toBeNull()
		// The content-type header is still present — only auth is conditional.
		expect(calls[0].contentType).toBe("application/x-ndjson")
	})
})
