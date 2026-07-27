import { beforeEach, describe, expect, it, vi } from "vitest"

// The capture modules install real DOM/global hooks; here we only need the
// `emit` callback they are handed, so we can drive events through the same
// path the browser would.
type EmitFn = (ev: { type: string; level?: string }) => void
let emitRef: EmitFn | undefined

const captureStub = (fn: (emit: EmitFn) => void) => (emit: EmitFn) => {
	fn(emit)
	return () => {}
}

vi.mock("./capture/navigation", () => ({
	installNavigationCapture: captureStub((emit) => {
		emitRef = emit
	}),
}))
vi.mock("./capture/interactions", () => ({ installInteractionCapture: () => () => {} }))
vi.mock("./capture/console", () => ({ installConsoleCapture: () => () => {} }))
vi.mock("./capture/network", () => ({ installNetworkCapture: () => () => {} }))
vi.mock("./capture/errors", () => ({ installErrorCapture: () => () => {} }))

vi.mock("../session", () => ({ markActivity: vi.fn() }))
vi.mock("./transport", () => ({ postSessionEvents: vi.fn(async () => {}) }))

const { startEventCapture } = await import("./events")

const CONFIG = { endpoint: "https://ingest.test", ingestKey: "k", maskAllInputs: false, maskAllText: false }

describe("startEventCapture session counters", () => {
	beforeEach(() => {
		emitRef = undefined
	})

	it("counts navigations as page views and errors as errors", () => {
		const capture = startEventCapture(CONFIG, "sess-1")
		const emit = emitRef
		if (!emit) throw new Error("capture module never received emit")

		emit({ type: "navigation" })
		emit({ type: "navigation" })
		emit({ type: "error" })
		emit({ type: "console", level: "error" })
		// Non-error console output and other event types must not inflate either count.
		emit({ type: "console", level: "log" })
		emit({ type: "click" })
		emit({ type: "network" })

		expect(capture.getPageViews()).toBe(2)
		expect(capture.getErrorCount()).toBe(2)
		capture.stop()
	})

	it("starts both counters at zero", () => {
		const capture = startEventCapture(CONFIG, "sess-2")
		expect(capture.getPageViews()).toBe(0)
		expect(capture.getErrorCount()).toBe(0)
		capture.stop()
	})

	it("keeps totals after a flush clears the buffer", async () => {
		const capture = startEventCapture(CONFIG, "sess-3")
		const emit = emitRef
		if (!emit) throw new Error("capture module never received emit")

		emit({ type: "navigation" })
		emit({ type: "error" })
		await capture.flush()

		// The `ended` metadata row is posted after a flush, so the counters must be
		// cumulative for the session rather than per-batch.
		expect(capture.getPageViews()).toBe(1)
		expect(capture.getErrorCount()).toBe(1)
		capture.stop()
	})
})
