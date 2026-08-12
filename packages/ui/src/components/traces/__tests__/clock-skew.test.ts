import { describe, expect, it } from "vitest"
import { adjustClockSkew, spanStartMs, summarizeClockSkew } from "../../../lib/span-tree"
import type { SpanNode } from "../../../lib/types"

/** Minimal span node; `startTime` is an ISO string like the warehouse returns. */
function node(partial: {
	spanId: string
	serviceName: string
	startMs: number
	durationMs: number
	children?: SpanNode[]
}): SpanNode {
	return {
		traceId: "t" as SpanNode["traceId"],
		spanId: partial.spanId as SpanNode["spanId"],
		parentSpanId: "",
		spanName: partial.spanId,
		serviceName: partial.serviceName,
		spanKind: "SPAN_KIND_INTERNAL",
		durationMs: partial.durationMs,
		startTime: new Date(partial.startMs).toISOString(),
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: {},
		resourceAttributes: {},
		children: partial.children ?? [],
		depth: 0,
	}
}

const BASE = Date.UTC(2026, 7, 12, 13, 20, 12)

describe("adjustClockSkew", () => {
	it("pulls a child that starts after its parent ended back inside it", () => {
		// The real shape from a browser→API trace: the client span reports 27.2ms
		// while the server span it caused starts 36.3ms later. Only clocks can do that.
		const child = node({
			spanId: "server",
			serviceName: "todo-api",
			startMs: BASE + 36.3,
			durationMs: 23.6,
		})
		const parent = node({
			spanId: "client",
			serviceName: "todo-web",
			startMs: BASE,
			durationMs: 27.2,
			children: [child],
		})

		const result = adjustClockSkew([parent])

		expect(result.adjustedCount).toBe(1)
		const parentStart = spanStartMs(parent)
		const childStart = spanStartMs(child)
		expect(childStart).toBeGreaterThanOrEqual(parentStart)
		expect(childStart + child.durationMs).toBeLessThanOrEqual(parentStart + parent.durationMs)
		// Centred in the parent's window, as Jaeger does. Millisecond tolerance:
		// `startTime` is a datetime string, so the fixture's fractional start is
		// truncated the same way the real UI truncates the warehouse's nanoseconds.
		expect(childStart - parentStart).toBeCloseTo((27.2 - 23.6) / 2, 3)
	})

	it("leaves the reported startTime untouched — only the drawn position moves", () => {
		const child = node({ spanId: "server", serviceName: "api", startMs: BASE + 40, durationMs: 5 })
		const parent = node({
			spanId: "client",
			serviceName: "web",
			startMs: BASE,
			durationMs: 20,
			children: [child],
		})
		const reported = child.startTime

		adjustClockSkew([parent])

		expect(child.startTime).toBe(reported)
		expect(child.clockSkewMs).toBeLessThan(0)
	})

	it("shifts the whole subtree by one delta, so relative timing inside it survives", () => {
		const grandchild = node({ spanId: "db", serviceName: "api", startMs: BASE + 42, durationMs: 3 })
		const child = node({
			spanId: "server",
			serviceName: "api",
			startMs: BASE + 40,
			durationMs: 10,
			children: [grandchild],
		})
		const parent = node({
			spanId: "client",
			serviceName: "web",
			startMs: BASE,
			durationMs: 20,
			children: [child],
		})

		adjustClockSkew([parent])

		expect(grandchild.clockSkewMs).toBe(child.clockSkewMs)
		expect(spanStartMs(grandchild) - spanStartMs(child)).toBeCloseTo(2, 6)
	})

	it("does not touch spans from the same service — one process, one clock", () => {
		// A child outside its parent within a single process is real data (or a real
		// bug); inventing a correction there would hide it.
		const child = node({ spanId: "b", serviceName: "api", startMs: BASE + 40, durationMs: 5 })
		const parent = node({
			spanId: "a",
			serviceName: "api",
			startMs: BASE,
			durationMs: 20,
			children: [child],
		})

		expect(adjustClockSkew([parent]).adjustedCount).toBe(0)
		expect(child.clockSkewMs).toBeUndefined()
	})

	it("leaves a child longer than its parent alone — that is not skew", () => {
		const child = node({ spanId: "server", serviceName: "api", startMs: BASE + 5, durationMs: 50 })
		const parent = node({
			spanId: "client",
			serviceName: "web",
			startMs: BASE,
			durationMs: 20,
			children: [child],
		})

		expect(adjustClockSkew([parent]).adjustedCount).toBe(0)
	})

	it("does nothing when the child already fits", () => {
		const child = node({ spanId: "server", serviceName: "api", startMs: BASE + 2, durationMs: 5 })
		const parent = node({
			spanId: "client",
			serviceName: "web",
			startMs: BASE,
			durationMs: 20,
			children: [child],
		})

		expect(adjustClockSkew([parent]).adjustedCount).toBe(0)
		expect(summarizeClockSkew([parent])).toBeNull()
	})

	it("summarizes the largest correction for the badge", () => {
		const child = node({ spanId: "server", serviceName: "api", startMs: BASE + 40, durationMs: 5 })
		const parent = node({
			spanId: "client",
			serviceName: "web",
			startMs: BASE,
			durationMs: 20,
			children: [child],
		})

		adjustClockSkew([parent])
		const summary = summarizeClockSkew([parent])

		expect(summary?.adjustedCount).toBe(1)
		expect(Math.abs(summary?.maxSkewMs ?? 0)).toBeCloseTo(32.5, 6)
	})
})
