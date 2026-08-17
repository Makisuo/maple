// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	noteNavigation: vi.fn(),
}))
vi.mock("../platform/transport", () => ({ postSessionEvents: vi.fn(async () => {}) }))

const { resetSinkForTests, startEventSink } = await import("./events-sink")
const { postSessionEvents } = await import("../platform/transport")
const { resetVisitorCacheForTests, setVisitorTracking } = await import("../identity/visitor")

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

// Every row carries the person key funnels group on. Resolved when the row is
// built, so a late `identify()` still lands on the buffered page view.
describe("startEventSink identity stamping", () => {
	const postedRows = () => vi.mocked(postSessionEvents).mock.calls.flatMap(([, rows]) => rows)

	beforeEach(() => {
		resetSinkForTests()
		resetVisitorCacheForTests()
		window.localStorage.clear()
		vi.mocked(postSessionEvents).mockClear()
	})

	it("stamps visitor_id, user_id and group_id on every row", async () => {
		const sink = startEventSink(
			{ ...CONFIG, getIdentity: () => ({ id: "user_1", groupId: "org_1", traits: {} }) },
			"sess-id-1",
		)
		sink.emit({ type: "custom", message: "signup_completed" })
		await sink.flush()

		const rows = postedRows()
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			expect(row.session_id).toBe("sess-id-1")
			expect(row.user_id).toBe("user_1")
			expect(row.group_id).toBe("org_1")
			expect(typeof row.visitor_id).toBe("string")
			expect(row.visitor_id).not.toBe("")
		}
		sink.stop()
	})

	it("reads identity when the row is built, so identify() after emit still applies", async () => {
		let identity: { id: string; traits: Record<string, string> } | undefined
		const sink = startEventSink({ ...CONFIG, getIdentity: () => identity }, "sess-id-2")
		sink.emit({ type: "custom", message: "before_identify" })
		identity = { id: "user_late", traits: {} }
		await sink.flush()

		expect(postedRows().every((row) => row.user_id === "user_late")).toBe(true)
		sink.stop()
	})

	it("sends empty strings when there is no identity and visitor tracking is off", async () => {
		setVisitorTracking(false)
		const sink = startEventSink(CONFIG, "sess-id-3")
		sink.emit({ type: "custom", message: "anon" })
		await sink.flush()

		const rows = postedRows()
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			expect(row.visitor_id).toBe("")
			expect(row.user_id).toBe("")
			expect(row.group_id).toBe("")
		}
		sink.stop()
	})
})
