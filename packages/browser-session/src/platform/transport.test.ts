import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keepaliveFor, postSessionEvents, postSessionMeta } from "./transport"

const CONFIG = {
	endpoint: "https://ingest.test",
	ingestKey: "k",
	maskAllInputs: false,
	maskAllText: false,
}

/** The RequestInit of the last fetch the transport issued. */
const lastInit = (fetchMock: ReturnType<typeof vi.fn>): RequestInit =>
	fetchMock.mock.calls.at(-1)?.[1] as RequestInit

describe("keepaliveFor", () => {
	it("passes small bodies through", () => {
		expect(keepaliveFor(true, 1_024)).toBe(true)
	})

	it("drops keepalive past the shared 64KiB budget", () => {
		// The browser rejects an over-budget keepalive request outright, so a
		// normal request the page may not outlive is still the better bet.
		expect(keepaliveFor(true, 64 * 1024)).toBe(false)
	})

	it("never turns keepalive on for a caller that didn't ask", () => {
		expect(keepaliveFor(false, 1)).toBe(false)
	})
})

describe("transport", () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
		vi.stubGlobal("fetch", fetchMock)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("posts metadata as a single NDJSON row with the ingest key", async () => {
		await postSessionMeta(CONFIG, { session_id: "s1", status: "ended" })

		expect(fetchMock).toHaveBeenCalledWith(
			"https://ingest.test/v1/sessionReplays/meta",
			expect.objectContaining({ method: "POST" }),
		)
		const init = lastInit(fetchMock)
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k")
		expect(init.body).toBe(`${JSON.stringify({ session_id: "s1", status: "ended" })}\n`)
	})

	it("drops keepalive on an oversized metadata row rather than losing it", async () => {
		// Realistic shape: 32-hex-char trace ids, the field that used to grow
		// without bound over a long session.
		const row = {
			session_id: "s1",
			trace_ids: Array.from({ length: 2_000 }, (_, i) => String(i).padStart(32, "0")),
		}
		await postSessionMeta(CONFIG, row, true)

		expect(lastInit(fetchMock).keepalive).toBe(false)
	})

	it("keeps keepalive on a normal-sized row", async () => {
		await postSessionMeta(CONFIG, { session_id: "s1" }, true)

		expect(lastInit(fetchMock).keepalive).toBe(true)
	})

	it("writes one NDJSON line per event and skips an empty batch", async () => {
		await postSessionEvents(CONFIG, [])
		expect(fetchMock).not.toHaveBeenCalled()

		await postSessionEvents(CONFIG, [{ seq: 0 }, { seq: 1 }])
		expect(lastInit(fetchMock).body).toBe('{"seq":0}\n{"seq":1}\n')
	})

	it("never throws into the host app when ingest is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("network down"))
		vi.spyOn(console, "warn").mockImplementation(() => {})

		await expect(postSessionMeta(CONFIG, { session_id: "s1" })).resolves.toBeUndefined()
		await expect(postSessionEvents(CONFIG, [{ seq: 0 }])).resolves.toBeUndefined()
	})
})
