// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { isCancellation, tracedFetch } from "./telemetry"

/**
 * Every Electric ShapeStream fetch flows through `tracedFetch`, and Electric
 * aborts those on purpose (pause/resume, teardown). Recording those aborts as
 * span errors put maple-web at a ~15% error rate that was ~99% cancellations, so
 * these tests pin both halves of the fix: cancellations are classified as such,
 * and the rejection the caller sees is still the untouched original.
 */
describe("isCancellation", () => {
	it("classifies Electric's pause-stream abort reason", () => {
		expect(isCancellation("pause-stream", undefined)).toBe(true)
	})

	it("classifies a bare AbortError from stream teardown", () => {
		const abortError = new DOMException("signal is aborted without reason", "AbortError")

		expect(isCancellation(abortError, undefined)).toBe(true)
	})

	it("classifies any rejection once our own signal is aborted", () => {
		const controller = new AbortController()
		controller.abort()

		expect(isCancellation(new Error("whatever"), controller.signal)).toBe(true)
	})

	it("does not classify a genuine network failure", () => {
		const controller = new AbortController()

		expect(isCancellation(new TypeError("Failed to fetch"), controller.signal)).toBe(false)
		expect(isCancellation(new TypeError("Failed to fetch"), undefined)).toBe(false)
	})

	it("does not classify an unrelated string rejection", () => {
		expect(isCancellation("boom", undefined)).toBe(false)
	})

	it("tolerates null and undefined causes", () => {
		expect(isCancellation(null, undefined)).toBe(false)
		expect(isCancellation(undefined, undefined)).toBe(false)
	})
})

describe("tracedFetch", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("resolves with the response on success", async () => {
		const response = new Response("ok", { status: 200 })
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response)

		await expect(tracedFetch("maple-api", "https://api.test/thing")).resolves.toBe(response)
	})

	it("resolves an HTTP error response rather than rejecting", async () => {
		const response = new Response("nope", { status: 500 })
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response)

		await expect(tracedFetch("maple-api", "https://api.test/thing")).resolves.toBe(response)
	})

	it("rethrows Electric's pause-stream reason verbatim", async () => {
		// Electric's pause/resume compares against this exact value, so the
		// cancellation path must not wrap or normalize it.
		vi.spyOn(globalThis, "fetch").mockRejectedValue("pause-stream")

		await expect(tracedFetch("electric-sync", "https://api.test/api/sync/shape")).rejects.toBe(
			"pause-stream",
		)
	})

	it("rethrows an AbortError verbatim", async () => {
		const abortError = new DOMException("signal is aborted without reason", "AbortError")
		vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError)

		await expect(tracedFetch("electric-sync", "https://api.test/api/sync/shape")).rejects.toBe(
			abortError,
		)
	})

	it("still rejects on a genuine network failure", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"))

		await expect(tracedFetch("maple-api", "https://api.test/thing")).rejects.toThrow("Failed to fetch")
	})
})
