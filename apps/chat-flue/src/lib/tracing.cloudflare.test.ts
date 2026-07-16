import { describe, expect, it, vi } from "vitest"

const worker = vi.hoisted(() => ({ enterSpan: vi.fn() }))
const otel = vi.hoisted(() => ({ startActiveSpan: vi.fn() }))

vi.mock("cloudflare:workers", () => ({
	tracing: { enterSpan: worker.enterSpan },
}))

vi.mock("@opentelemetry/api", () => ({
	SpanStatusCode: { ERROR: 2 },
	trace: {
		getTracer: () => ({ startActiveSpan: otel.startActiveSpan }),
	},
}))

import { enterSpan } from "./tracing.ts"

describe("enterSpan in workerd", () => {
	it("does not replay a callback rejected by the Cloudflare tracing backend", async () => {
		worker.enterSpan.mockImplementationOnce(
			async <T>(_name: string, callback: (span: { setAttribute: () => void }) => Promise<T>) =>
				callback({ setAttribute: vi.fn() }),
		)
		let calls = 0

		await expect(
			enterSpan("chat.turn", async () => {
				calls += 1
				throw new Error("worker callback failed")
			}),
		).rejects.toThrow("worker callback failed")

		expect(calls).toBe(1)
		expect(worker.enterSpan).toHaveBeenCalledOnce()
		expect(otel.startActiveSpan).not.toHaveBeenCalled()
	})
})
