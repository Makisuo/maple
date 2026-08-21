// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../session/session", () => ({
	markActivity: vi.fn(),
	noteNavigation: vi.fn(),
}))
const postSessionEvents = vi.fn(async () => {})
vi.mock("../platform/transport", () => ({ postSessionEvents }))

const { track } = await import("./track")
const { resetSinkForTests, startEventSink } = await import("./events-sink")
const { configurePrivacy, resetConsentForTests, setConsent } = await import("../identity/consent")
const { markActivity } = await import("../session/session")

const CONFIG = {
	endpoint: "https://ingest.test",
	ingestKey: "k",
	sdk: "maple-test/0.0.0",
	maskAllInputs: false,
	maskAllText: false,
}

/** Rows the sink actually POSTed, flattened across batches. */
async function flushedRows(sessionId: string): Promise<Array<Record<string, unknown>>> {
	const sink = startEventSink(CONFIG, sessionId)
	await sink.flush()
	return postSessionEvents.mock.calls.flatMap(
		// SAFETY: `postSessionEvents` is called with the request metadata followed by its row batch.
		(call) => (call as unknown as [unknown, Array<Record<string, unknown>>])[1],
	)
}

describe("track", () => {
	beforeEach(() => {
		resetSinkForTests()
		resetConsentForTests()
		vi.mocked(markActivity).mockReset()
		postSessionEvents.mockClear()
	})

	it("emits a custom session event with the name in message and props in attributes", async () => {
		startEventSink(CONFIG, "sess-1")
		track("cta-button-click", {
			button_id: "signup_cta",
			page: "/pricing",
			variant: "blue",
		})

		const rows = await flushedRows("sess-1")
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			type: "custom",
			message: "cta-button-click",
			attributes: {
				button_id: "signup_cta",
				page: "/pricing",
				variant: "blue",
			},
		})
	})

	it("queues events fired before the sink exists and drains them in order", async () => {
		// A click handler can easily fire before init finishes; dropping those
		// would silently lose the most interesting events on a page.
		track("first", { n: 1 })
		track("second", { n: 2 })

		const rows = await flushedRows("sess-2")
		expect(rows.map((row) => row.message)).toEqual(["first", "second"])
	})

	it("shares one seq counter with capture events", async () => {
		const sink = startEventSink(CONFIG, "sess-3")
		sink.emit({ type: "click" })
		track("checkout_started")
		sink.emit({ type: "network" })

		const rows = await flushedRows("sess-3")
		// Seq is part of the session_events sorting key — a separate counter for
		// custom events would collide with capture rows.
		expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
	})

	it("routes the activity that discovers idle rotation to a fresh sink", async () => {
		const oldSink = startEventSink(CONFIG, "sess-old")
		vi.mocked(markActivity).mockReturnValue({ id: "sess-new" } as never)
		oldSink.emit({ type: "click", targetText: "new-session-click" })

		const rows = await flushedRows("sess-new")
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ session_id: "sess-new", seq: 0, target_text: "new-session-click" })
	})

	it("coerces non-string prop values and drops the unusable ones", async () => {
		startEventSink(CONFIG, "sess-4")
		track("mixed", {
			count: 3,
			flag: true,
			when: new Date("2026-08-02T00:00:00.000Z"),
			nested: { a: 1 },
			nothing: null,
			fn: () => {},
		})

		const rows = await flushedRows("sess-4")
		expect(rows[0]?.attributes).toEqual({
			count: "3",
			flag: "true",
			when: "2026-08-02T00:00:00.000Z",
			nested: '{"a":1}',
		})
	})

	it("survives a circular prop instead of throwing into the caller", async () => {
		startEventSink(CONFIG, "sess-5")
		interface CircularProps extends Record<string, unknown> {
			self?: CircularProps
		}
		const circular: CircularProps = { name: "loop" }
		circular.self = circular

		expect(() => track("cyclic", { circular, ok: "yes" })).not.toThrow()
		const rows = await flushedRows("sess-5")
		expect(rows[0]?.attributes).toEqual({ ok: "yes" })
	})

	it("drops an invalid Date property instead of throwing", async () => {
		startEventSink(CONFIG, "sess-invalid-date")
		expect(() => track("invalid-date", { when: new Date(Number.NaN), ok: "yes" })).not.toThrow()

		const rows = await flushedRows("sess-invalid-date")
		expect(rows[0]?.attributes).toEqual({ ok: "yes" })
	})

	it("does not queue pre-consent events for a later grant", async () => {
		configurePrivacy({ requireConsent: true })
		track("before-consent", { secret: "never-upload" })
		setConsent(true)

		const rows = await flushedRows("sess-consented")
		expect(rows).toHaveLength(0)
	})

	it("caps the event name and the property count", async () => {
		startEventSink(CONFIG, "sess-6")
		const props: Record<string, string> = {}
		for (let i = 0; i < 100; i++) props[`k${i}`] = "v"
		track("n".repeat(500), props)

		const rows = await flushedRows("sess-6")
		expect(String(rows[0]?.message)).toHaveLength(128)
		expect(Object.keys(rows[0]?.attributes as object)).toHaveLength(32)
	})

	it("ignores a call with no usable event name", async () => {
		startEventSink(CONFIG, "sess-7")
		track("")
		track("   ")

		const rows = await flushedRows("sess-7")
		expect(rows).toHaveLength(0)
	})
})
