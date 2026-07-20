import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect, Redacted } from "effect"
import {
	buildResolved,
	makeSerializedFlush,
	runFlush,
	type FlushTransport,
	type SignalState,
} from "./flush-core.js"
import { makeLogBuffer } from "./flushable-logger.js"
import { makeSpanBuffer } from "./flushable-tracer.js"

const resolved = buildResolved(
	{
		endpoint: "https://collector.test",
		ingestKey: Redacted.make("test-key"),
		resource: { serviceName: "test", serviceVersion: undefined, attributes: {} },
	},
	{ userAgent: "test" },
)

const recordSpan = (spans: ReturnType<typeof makeSpanBuffer>, name: string) =>
	Effect.runPromise(Effect.succeed(undefined).pipe(Effect.withSpan(name), Effect.provide(spans.tracerLayer)))

const recordLog = (logs: ReturnType<typeof makeLogBuffer>, message: string) =>
	Effect.runPromise(Effect.logInfo(message).pipe(Effect.provide(logs.loggerLayer)))

describe("runFlush", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("retains failed and cooldown batches while allowing the other signal to succeed", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
		const spans = makeSpanBuffer()
		const logs = makeLogBuffer()
		const tracesState: SignalState = { disabledUntil: 0 }
		const logsState: SignalState = { disabledUntil: 0 }
		const traceBodies: unknown[] = []
		const logBodies: unknown[] = []
		let failTraces = true
		const transport: FlushTransport = {
			post: async (url, _headers, body) => {
				if (url.endsWith("/v1/traces")) {
					if (failTraces) throw new Error("collector unavailable")
					traceBodies.push(body)
				} else {
					logBodies.push(body)
				}
			},
		}
		const flush = () =>
			runFlush({
				resolved,
				spans,
				logs,
				tracesState,
				logsState,
				transport,
				logPrefix: "[test]",
				onNoOp: () => undefined,
			})

		await recordSpan(spans, "first")
		await recordLog(logs, "first-log")
		await flush()
		expect(spans.size()).toBe(1)
		expect(logs.size()).toBe(0)
		expect(logBodies).toHaveLength(1)

		await recordSpan(spans, "second")
		await flush()
		expect(spans.size()).toBe(2)
		expect(traceBodies).toHaveLength(0)

		failTraces = false
		vi.advanceTimersByTime(60_000)
		await flush()
		expect(spans.size()).toBe(0)
		expect(traceBodies).toHaveLength(1)
		const body = traceBodies[0] as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
		}
		expect(body.resourceSpans[0]!.scopeSpans[0]!.spans.map((span) => span.name)).toEqual([
			"first",
			"second",
		])
	})

	it("serializes overlapping flush calls", async () => {
		let active = 0
		let peak = 0
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const run = makeSerializedFlush(async () => {
			active += 1
			peak = Math.max(peak, active)
			await gate
			active -= 1
		})

		const first = run()
		const second = run()
		await Promise.resolve()
		expect(peak).toBe(1)
		release?.()
		await Promise.all([first, second])
		expect(peak).toBe(1)
	})
})
