// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	noteNavigation: vi.fn(),
}))
vi.mock("../platform/transport", () => ({ postSessionEvents: vi.fn(async () => {}) }))

const { resetSinkForTests, startEventSink } = await import("./events-sink")

const CONFIG = {
	endpoint: "https://ingest.test",
	ingestKey: "k",
	maskAllInputs: false,
	maskAllText: false,
}

// The sink runs on every page load, sampled for replay or not. These pin the
// counters it is responsible for feeding — the ones the Sessions UI reads —
// against the regression where they only worked on the sampled replay path.
describe("startEventSink baseline counters", () => {
	beforeEach(() => {
		resetSinkForTests()
		document.body.innerHTML = ""
	})

	it("counts uncaught errors without any replay capture installed", () => {
		const sink = startEventSink(CONFIG, "sess-1")
		window.dispatchEvent(new ErrorEvent("error", { message: "boom" }))

		expect(sink.getErrorCount()).toBe(1)
		sink.stop()
	})

	it("counts unhandled rejections as errors", () => {
		const sink = startEventSink(CONFIG, "sess-2")
		window.dispatchEvent(new Event("unhandledrejection") as PromiseRejectionEvent)

		expect(sink.getErrorCount()).toBe(1)
		sink.stop()
	})

	it("counts clicks without any replay capture installed", () => {
		const sink = startEventSink(CONFIG, "sess-3")
		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()
		button.click()

		expect(sink.getClickCount()).toBe(2)
		sink.stop()
	})

	it("counts each click exactly once", () => {
		// Regression: errors and interactions used to be installed by the
		// replay-only capture module. Now that the sink owns them, the replay path
		// must not install a second listener on top.
		const sink = startEventSink(CONFIG, "sess-4")
		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()

		expect(sink.getClickCount()).toBe(1)
		sink.stop()
	})

	it("stops counting once the sink is stopped", () => {
		const sink = startEventSink(CONFIG, "sess-5")
		sink.stop()

		window.dispatchEvent(new ErrorEvent("error", { message: "boom" }))
		const button = document.createElement("button")
		document.body.appendChild(button)
		button.click()

		expect(sink.getErrorCount()).toBe(0)
		expect(sink.getClickCount()).toBe(0)
	})
})
