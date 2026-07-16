import { describe, expect, it, vi } from "vitest"

const otel = vi.hoisted(() => {
	const end = vi.fn()
	const setAttribute = vi.fn()
	const setStatus = vi.fn()
	const recordException = vi.fn()
	const startActiveSpan = vi.fn(
		async <T>(
			_name: string,
			fn: (span: {
				end: () => void
				setAttribute: typeof setAttribute
				recordException: typeof recordException
				setStatus: typeof setStatus
			}) => Promise<T>,
		) => fn({ end, recordException, setAttribute, setStatus }),
	)
	return { end, recordException, setAttribute, setStatus, startActiveSpan }
})

vi.mock("@opentelemetry/api", () => ({
	SpanStatusCode: { ERROR: 2 },
	trace: {
		getTracer: () => ({ startActiveSpan: otel.startActiveSpan }),
	},
}))

import { enterSpan } from "./tracing.ts"

describe("enterSpan", () => {
	it("does not replay a rejected callback and always ends the fallback span", async () => {
		let calls = 0
		await expect(
			enterSpan("chat.turn", async () => {
				calls += 1
				throw new Error("turn failed")
			}),
		).rejects.toThrow("turn failed")

		expect(calls).toBe(1)
		expect(otel.startActiveSpan).toHaveBeenCalledOnce()
		expect(otel.recordException).toHaveBeenCalledOnce()
		expect(otel.setStatus).toHaveBeenCalledWith({ code: 2, message: "turn failed" })
		expect(otel.setAttribute).toHaveBeenCalledWith("otel.status_code", "Error")
		expect(otel.end).toHaveBeenCalledOnce()
	})
})
