import { beforeEach, describe, expect, it, vi } from "vitest"

// The capture modules install real DOM/global hooks; here we only need the
// `emit` callback they are handed, so we can drive events through the same
// path the browser would. Console is the hook we borrow — navigation, errors
// and interactions are no longer replay-only capture modules (the sink installs
// them, so they are counted even when replay is unsampled).
type EmitFn = (ev: { type: string; level?: string }) => void
let emitRef: EmitFn | undefined

const captureStub = (fn: (emit: EmitFn) => void) => (emit: EmitFn) => {
	fn(emit)
	return () => {}
}

vi.mock("./capture/console", () => ({
	installConsoleCapture: captureStub((emit) => {
		emitRef = emit
	}),
}))
vi.mock("./capture/network", () => ({ installNetworkCapture: () => () => {} }))

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	noteNavigation: vi.fn(),
}))
vi.mock("../platform/transport", () => ({ postSessionEvents: vi.fn(async () => {}) }))

const { startEventCapture } = await import("./events")
const { getActiveSink, resetSinkForTests } = await import("../events/events-sink")

const CONFIG = {
	endpoint: "https://ingest.test",
	ingestKey: "k",
	maskAllInputs: false,
	maskAllText: false,
}

describe("startEventCapture session counters", () => {
	beforeEach(() => {
		emitRef = undefined
		resetSinkForTests()
	})

	it("counts navigations as page views and errors as errors", () => {
		const capture = startEventCapture(CONFIG, "sess-1")
		const sink = getActiveSink()
		if (!sink) throw new Error("capture never started a sink")
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
		emit({ type: "custom" })

		expect(sink.getPageViews()).toBe(2)
		expect(sink.getErrorCount()).toBe(2)
		capture.stop()
	})

	it("starts both counters at zero", () => {
		const capture = startEventCapture(CONFIG, "sess-2")
		expect(getActiveSink()?.getPageViews()).toBe(0)
		expect(getActiveSink()?.getErrorCount()).toBe(0)
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
		expect(getActiveSink()?.getPageViews()).toBe(1)
		expect(getActiveSink()?.getErrorCount()).toBe(1)
		capture.stop()
	})

	it("keeps the sink alive after capture stops, so track() still works", () => {
		const capture = startEventCapture(CONFIG, "sess-4")
		capture.stop()
		// stop() uninstalls the listeners only. The sink outlives them, because a
		// custom event fired while the tab is tearing down still has to land.
		expect(getActiveSink()).toBeDefined()
	})
})
