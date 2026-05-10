import { describe, expect, mock, test } from "bun:test"
import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api"

import { withSpan } from "./index.ts"

interface RecordedSpan {
	name: string
	ended: boolean
	status: { code: SpanStatusCode; message?: string } | null
	attributes: Record<string, unknown>
	exceptions: unknown[]
}

function fakeTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
	const spans: RecordedSpan[] = []
	const tracer = {
		startActiveSpan: ((...args: unknown[]) => {
			const name = args[0] as string
			const fn = args[args.length - 1] as (span: Span) => unknown
			const recorded: RecordedSpan = {
				name,
				ended: false,
				status: null,
				attributes: {},
				exceptions: [],
			}
			const span = {
				setAttribute(key: string, value: unknown) {
					recorded.attributes[key] = value
					return span
				},
				setAttributes(attrs: Record<string, unknown>) {
					Object.assign(recorded.attributes, attrs)
					return span
				},
				setStatus(status: { code: SpanStatusCode; message?: string }) {
					recorded.status = status
					return span
				},
				recordException(err: unknown) {
					recorded.exceptions.push(err)
				},
				end() {
					recorded.ended = true
				},
			} as unknown as Span
			spans.push(recorded)
			return fn(span)
		}) as Tracer["startActiveSpan"],
	} as Tracer
	return { tracer, spans }
}

describe("withSpan", () => {
	test("ends the span on success and returns the inner value", async () => {
		const { tracer, spans } = fakeTracer()

		const result = await withSpan(
			"order.submit",
			(span) => {
				span.setAttribute("order.id", "ord_1")
				return 42
			},
			{ tracer },
		)

		expect(result).toBe(42)
		expect(spans).toHaveLength(1)
		expect(spans[0]!.name).toBe("order.submit")
		expect(spans[0]!.ended).toBe(true)
		expect(spans[0]!.status).toBeNull()
		expect(spans[0]!.exceptions).toHaveLength(0)
		expect(spans[0]!.attributes["order.id"]).toBe("ord_1")
	})

	test("records the exception, sets ERROR status, ends the span, and rethrows", async () => {
		const { tracer, spans } = fakeTracer()
		const boom = new Error("payment declined")

		const promise = withSpan(
			"payment.charge",
			() => {
				throw boom
			},
			{ tracer },
		)

		await expect(promise).rejects.toBe(boom)
		expect(spans).toHaveLength(1)
		expect(spans[0]!.ended).toBe(true)
		expect(spans[0]!.exceptions).toEqual([boom])
		expect(spans[0]!.status).toEqual({
			code: SpanStatusCode.ERROR,
			message: "payment declined",
		})
	})

	test("handles non-Error throws by stringifying for the status message", async () => {
		const { tracer, spans } = fakeTracer()

		const promise = withSpan(
			"agent.run",
			() => {
				throw "stringy failure"
			},
			{ tracer },
		)

		await expect(promise).rejects.toBe("stringy failure")
		expect(spans[0]!.ended).toBe(true)
		expect(spans[0]!.status?.code).toBe(SpanStatusCode.ERROR)
		expect(spans[0]!.status?.message).toBe("stringy failure")
	})

	test("awaits async fn before ending the span", async () => {
		const { tracer, spans } = fakeTracer()
		const order: string[] = []

		await withSpan(
			"job.process",
			async () => {
				order.push("body-start")
				await new Promise((r) => setTimeout(r, 5))
				order.push("body-end")
			},
			{ tracer },
		)

		expect(order).toEqual(["body-start", "body-end"])
		expect(spans[0]!.ended).toBe(true)
	})

	test("forwards span options to startActiveSpan", async () => {
		const startActiveSpan = mock((...args: unknown[]) => {
			const fn = args[args.length - 1] as (span: Span) => unknown
			return fn({
				setAttribute: () => undefined,
				setAttributes: () => undefined,
				setStatus: () => undefined,
				recordException: () => undefined,
				end: () => undefined,
			} as unknown as Span)
		})
		const tracer = { startActiveSpan } as unknown as Tracer

		await withSpan("op", () => undefined, {
			tracer,
			attributes: { "tenant.id": "t_1" },
			kind: 1,
		})

		expect(startActiveSpan.mock.calls).toHaveLength(1)
		const call = startActiveSpan.mock.calls[0]!
		expect(call[0]).toBe("op")
		expect(call[1]).toEqual({
			attributes: { "tenant.id": "t_1" },
			kind: 1,
		})
	})
})
