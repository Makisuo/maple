import type { Span } from "@opentelemetry/sdk-trace-base"
import { describe, expect, it } from "vitest"
import { TraceIdCollector } from "./tracing"

function makeSpan() {
	const attributes = new Map<string, unknown>()
	const span = {
		spanContext: () => ({ traceId: "0123456789abcdef0123456789abcdef" }),
		setAttribute: (key: string, value: unknown) => {
			attributes.set(key, value)
			return span
		},
	} as unknown as Span
	return { attributes, span }
}

describe("TraceIdCollector", () => {
	it("stamps future spans with the current identified user", () => {
		const state: { userId: string | undefined } = { userId: undefined }
		const collector = new TraceIdCollector(() => state.userId)

		const anonymous = makeSpan()
		collector.onStart(anonymous.span)
		expect(anonymous.attributes.get("user.id")).toBeUndefined()

		state.userId = "user_123"
		const identified = makeSpan()
		collector.onStart(identified.span)
		expect(identified.attributes.get("user.id")).toBe("user_123")

		state.userId = undefined
		const cleared = makeSpan()
		collector.onStart(cleared.span)
		expect(cleared.attributes.get("user.id")).toBeUndefined()
	})
})
