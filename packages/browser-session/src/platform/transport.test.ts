import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	gzip,
	keepaliveFor,
	postSessionBlob,
	postSessionEvents,
	postSessionMeta,
	SDK_HINT_HEADER,
	sdkHint,
} from "./transport"

const CONFIG = {
	endpoint: "https://ingest.test",
	ingestKey: "k",
	sdk: "maple-test/0.0.0",
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

	it("stamps the SDK identity hint on every request", async () => {
		// Ingest records this as `maple.sdk`; without it a rejected browser
		// request carries nothing that says which SDK build produced it.
		const CHUNK = { sessionId: "s1", chunkSeq: 0, isCheckpoint: true, eventCount: 1, durationMs: 0 }
		await postSessionMeta(CONFIG, { session_id: "s1" })
		expect((lastInit(fetchMock).headers as Record<string, string>)[SDK_HINT_HEADER]).toBe(
			"maple-test/0.0.0",
		)
		await postSessionEvents(CONFIG, [{ seq: 0 }])
		expect((lastInit(fetchMock).headers as Record<string, string>)[SDK_HINT_HEADER]).toBe(
			"maple-test/0.0.0",
		)
		await postSessionBlob(CONFIG, CHUNK, new Uint8Array([0x1f, 0x8b]))
		expect((lastInit(fetchMock).headers as Record<string, string>)[SDK_HINT_HEADER]).toBe(
			"maple-test/0.0.0",
		)
		expect(sdkHint("maple-browser", "1.2.3")).toBe("maple-browser/1.2.3")
	})

	it("reports how ingest answered a chunk, and 413 as the session being exhausted", async () => {
		const CHUNK = { sessionId: "s1", chunkSeq: 0, isCheckpoint: true, eventCount: 1, durationMs: 0 }
		const bytes = new Uint8Array([0x1f, 0x8b])
		expect(await postSessionBlob(CONFIG, CHUNK, bytes)).toBe("accepted")
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 413 }))
		expect(await postSessionBlob(CONFIG, CHUNK, bytes)).toBe("exhausted")
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }))
		expect(await postSessionBlob(CONFIG, CHUNK, bytes)).toBe("rejected")
		vi.spyOn(console, "warn").mockImplementation(() => {})
		fetchMock.mockRejectedValueOnce(new Error("network down"))
		expect(await postSessionBlob(CONFIG, CHUNK, bytes)).toBe("failed")
	})

	it("never throws into the host app when ingest is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("network down"))
		vi.spyOn(console, "warn").mockImplementation(() => {})

		await expect(postSessionMeta(CONFIG, { session_id: "s1" })).resolves.toBeUndefined()
		await expect(postSessionEvents(CONFIG, [{ seq: 0 }])).resolves.toBeUndefined()
	})
})

describe("gzip", () => {
	it("produces a complete gzip stream", async () => {
		const out = await gzip(new TextEncoder().encode('[{"type":2,"timestamp":1}]'))
		expect([out[0], out[1], out[2]]).toEqual([0x1f, 0x8b, 0x08])
		expect(out.length).toBeGreaterThanOrEqual(18)
	})

	it("round-trips through DecompressionStream", async () => {
		const body = `[${Array.from({ length: 200 }, (_, i) => `{"type":3,"timestamp":${i}}`).join(",")}]`
		const out = await gzip(new TextEncoder().encode(body))
		const stream = new DecompressionStream("gzip")
		const writer = stream.writable.getWriter()
		const written = writer.write(out as BufferSource).then(() => writer.close())
		const [buffer] = await Promise.all([new Response(stream.readable).arrayBuffer(), written])
		expect(new TextDecoder().decode(buffer)).toBe(body)
	})

	// The production failure: a torn-down page left `arrayBuffer()` resolving
	// with only the bytes already flushed, and the caller posted the stub as if
	// it were a chunk. Compression that cannot complete must throw, not truncate.
	it("rejects a truncated stream instead of returning it", async () => {
		const realCompressionStream = globalThis.CompressionStream
		class TruncatingStream {
			readonly readable = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([0x1f, 0x8b, 0x08]))
					controller.close()
				},
			})
			readonly writable = new WritableStream()
		}
		globalThis.CompressionStream = TruncatingStream as unknown as typeof CompressionStream
		await expect(gzip(new TextEncoder().encode("[]"))).rejects.toThrow(/not a complete gzip stream/)
		globalThis.CompressionStream = realCompressionStream
	})
})
