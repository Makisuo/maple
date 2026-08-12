import { StrictMode } from "react"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useViewportController } from "../use-viewport-controller"
import { viewportBounds } from "../clamp-viewport"
import { MIN_VISIBLE_ABS_MS } from "../trace-timeline-types"

const TRACE_START = 1_000_000
const TRACE_END = 1_010_000 // 10s trace

function setup(initial = { startMs: TRACE_START, endMs: TRACE_START + 2_000 }) {
	return renderHook(() =>
		useViewportController({
			traceStartMs: TRACE_START,
			traceEndMs: TRACE_END,
			initialViewport: initial,
		}),
	)
}

/** Run every rAF callback queued so far (the controller coalesces notifications onto one). */
function flushFrames() {
	act(() => {
		vi.advanceTimersToNextFrame()
	})
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe("viewport commits", () => {
	it("clamps through clampViewport on every path", () => {
		const { result } = setup()
		act(() => result.current.set({ startMs: TRACE_START - 500_000, endMs: TRACE_START - 400_000 }))
		const vp = result.current.get()
		// 5% padding either side of a 10s trace.
		expect(vp.startMs).toBeGreaterThanOrEqual(TRACE_START - 500)
		expect(vp.endMs).toBeLessThanOrEqual(TRACE_END + 500)
	})

	it("floors a collapsed window instead of inverting it", () => {
		const { result } = setup()
		act(() => result.current.zoomToRange(TRACE_START + 5_000, TRACE_START + 5_000))
		const vp = result.current.get()
		expect(vp.endMs - vp.startMs).toBeCloseTo(MIN_VISIBLE_ABS_MS, 6)
	})

	it("normalizes a reversed zoomToRange", () => {
		const { result } = setup()
		act(() => result.current.zoomToRange(TRACE_START + 3_000, TRACE_START + 2_000))
		expect(result.current.get().startMs).toBeCloseTo(TRACE_START + 2_000, 6)
		expect(result.current.get().endMs).toBeCloseTo(TRACE_START + 3_000, 6)
	})

	it("fit() lands exactly on the navigable bounds", () => {
		// Not merely "covers the trace": it has to be *exactly* the bounds, because that is the
		// span the minimap strip draws. Anything else and a fitted timeline sits a couple of
		// percent out of step with the strip, which reads as the minimap being misaligned.
		const { result } = setup()
		act(() => result.current.fit())
		act(() => {
			vi.advanceTimersByTime(400) // eased
		})
		const bounds = viewportBounds(TRACE_START, TRACE_END)
		expect(result.current.get().startMs).toBeCloseTo(bounds.loMs, 6)
		expect(result.current.get().endMs).toBeCloseTo(bounds.hiMs, 6)
	})
})

describe("zoomAt", () => {
	it("holds the anchor time fixed at its position in the window", () => {
		const { result } = setup({ startMs: TRACE_START, endMs: TRACE_START + 4_000 })
		const anchor = TRACE_START + 1_000 // 25% across the window
		act(() => result.current.zoomAt(anchor, 2))
		const vp = result.current.get()
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
		expect((anchor - vp.startMs) / (vp.endMs - vp.startMs)).toBeCloseTo(0.25, 6)
	})

	it("zooms out with a factor below 1", () => {
		const { result } = setup({ startMs: TRACE_START + 4_000, endMs: TRACE_START + 6_000 })
		act(() => result.current.zoomAt(TRACE_START + 5_000, 0.5))
		expect(result.current.get().endMs - result.current.get().startMs).toBeCloseTo(4_000, 6)
	})
})

describe("panBy", () => {
	it("shifts the window and preserves its width", () => {
		const { result } = setup({ startMs: TRACE_START + 1_000, endMs: TRACE_START + 3_000 })
		act(() => result.current.panBy(500))
		const vp = result.current.get()
		expect(vp.startMs).toBeCloseTo(TRACE_START + 1_500, 6)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
	})

	it("stops at the trace edge rather than drifting away", () => {
		const { result } = setup({ startMs: TRACE_START + 1_000, endMs: TRACE_START + 3_000 })
		act(() => result.current.panBy(1_000_000))
		const vp = result.current.get()
		expect(vp.endMs).toBeLessThanOrEqual(TRACE_END + 500)
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 6)
	})
})

describe("subscribers", () => {
	it("primes a new subscriber with the current window", () => {
		const { result } = setup()
		const cb = vi.fn()
		act(() => {
			result.current.subscribe(cb)
		})
		expect(cb).toHaveBeenCalledTimes(1)
		expect(cb.mock.calls[0][0]).toEqual(result.current.get())
	})

	it("coalesces a burst of commits into a single notification", () => {
		const { result } = setup()
		const cb = vi.fn()
		act(() => {
			result.current.subscribe(cb)
		})
		cb.mockClear()
		act(() => {
			for (let i = 0; i < 10; i++) result.current.panBy(10)
		})
		// Ten commits, one frame: the DOM was written ten times but React-land hears once.
		expect(cb).not.toHaveBeenCalled()
		flushFrames()
		expect(cb).toHaveBeenCalledTimes(1)
		expect(cb.mock.calls[0][0]).toEqual(result.current.get())
	})

	it("keeps notifying through StrictMode's mount/unmount/remount", () => {
		// The unmount cleanup cancels the pending frame; if it leaves the id behind, `notify`
		// reads it as "a frame is already scheduled" and silently drops every later
		// notification. StrictMode does exactly this cycle on the first paint against the same
		// refs, which froze the ruler and the minimap for the whole session in dev while the
		// CSS-var path kept working — so the symptom looked like a tick-math bug, not a leak.
		const { result } = renderHook(
			() =>
				useViewportController({
					traceStartMs: TRACE_START,
					traceEndMs: TRACE_END,
					initialViewport: { startMs: TRACE_START, endMs: TRACE_START + 2_000 },
				}),
			{ wrapper: StrictMode },
		)
		const cb = vi.fn()
		act(() => {
			result.current.subscribe(cb)
		})
		cb.mockClear()
		act(() => result.current.panBy(10))
		flushFrames()
		expect(cb).toHaveBeenCalledTimes(1)
	})

	it("stops notifying after unsubscribe", () => {
		const { result } = setup()
		const cb = vi.fn()
		let unsubscribe = () => {}
		act(() => {
			unsubscribe = result.current.subscribe(cb)
		})
		act(() => unsubscribe())
		cb.mockClear()
		act(() => result.current.panBy(10))
		flushFrames()
		expect(cb).not.toHaveBeenCalled()
	})
})

describe("time surfaces", () => {
	it("writes the window as trace-relative --vp0 and --vpk", () => {
		const { result } = setup({ startMs: TRACE_START + 1_000, endMs: TRACE_START + 3_000 })
		const el = document.createElement("div")
		act(() => {
			result.current.bindTimeSurface(el)
		})
		// Bound elements are primed immediately, not on the next commit.
		expect(Number(el.style.getPropertyValue("--vp0"))).toBeCloseTo(1_000, 6)
		expect(Number(el.style.getPropertyValue("--vpk"))).toBeCloseTo(100 / 2_000, 9)

		act(() => result.current.panBy(500))
		expect(Number(el.style.getPropertyValue("--vp0"))).toBeCloseTo(1_500, 6)
	})

	it("positions a bar at the fraction of the window CSS would compute", () => {
		// Mirrors `calc((var(--b0) - var(--vp0)) * var(--vpk) * 1%)` from the row.
		const { result } = setup({ startMs: TRACE_START + 1_000, endMs: TRACE_START + 3_000 })
		const el = document.createElement("div")
		act(() => {
			result.current.bindTimeSurface(el)
		})
		const vp0 = Number(el.style.getPropertyValue("--vp0"))
		const vpk = Number(el.style.getPropertyValue("--vpk"))
		// A span starting halfway through the window (trace-relative 2000ms).
		expect((2_000 - vp0) * vpk).toBeCloseTo(50, 6)
	})

	it("stops writing an unbound element", () => {
		const { result } = setup()
		const el = document.createElement("div")
		let unbind = () => {}
		act(() => {
			unbind = result.current.bindTimeSurface(el)
		})
		act(() => unbind())
		const before = el.style.getPropertyValue("--vp0")
		act(() => result.current.panBy(500))
		expect(el.style.getPropertyValue("--vp0")).toBe(before)
	})
})

describe("animateTo", () => {
	it("eases to the target and lands exactly on it", () => {
		const { result } = setup({ startMs: TRACE_START, endMs: TRACE_START + 10_000 })
		act(() => result.current.animateTo({ startMs: TRACE_START, endMs: TRACE_START + 2_000 }, 100))
		act(() => {
			vi.advanceTimersByTime(200)
		})
		const vp = result.current.get()
		expect(vp.endMs - vp.startMs).toBeCloseTo(2_000, 3)
	})

	it("cancelAnimation freezes it mid-flight so a direct gesture wins", () => {
		const { result } = setup({ startMs: TRACE_START, endMs: TRACE_START + 10_000 })
		act(() => result.current.animateTo({ startMs: TRACE_START, endMs: TRACE_START + 1_000 }, 400))
		flushFrames()
		act(() => result.current.cancelAnimation())
		const frozen = result.current.get()
		act(() => {
			vi.advanceTimersByTime(1_000)
		})
		expect(result.current.get()).toEqual(frozen)
	})
})
