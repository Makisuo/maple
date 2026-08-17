import { afterEach, describe, expect, it } from "vitest"

import {
	clearSessionSink,
	getObservedTraceIds,
	publishSessionSink,
	readSessionSink,
	recordTraceId,
} from "./sink"

afterEach(() => {
	// The published sink is the only handle on the module's per-session map, so
	// clearing it between tests is what keeps ids from leaking across cases.
	const current = readSessionSink()
	if (current) clearSessionSink(current.sessionId)
})

describe("trace ids", () => {
	it("scopes ids to the session that was live when they were recorded", () => {
		publishSessionSink("session-a")
		recordTraceId("trace-1")
		recordTraceId("trace-2")
		recordTraceId("trace-1") // idempotent per id

		expect(getObservedTraceIds("session-a")).toEqual(["trace-1", "trace-2"])
		expect(getObservedTraceIds("session-b")).toEqual([])
	})

	it("records through a captured sink under the session that sink belongs to", () => {
		publishSessionSink("session-a")
		const sinkA = readSessionSink()!
		publishSessionSink("session-b")

		// An external tracer that grabbed the sink before rotation keeps writing
		// to the session it was handed, not to whatever is current.
		sinkA.recordTraceId("late-trace")

		expect(getObservedTraceIds("session-a")).toEqual(["late-trace"])
		expect(getObservedTraceIds("session-b")).toEqual([])
	})

	it("drops nothing for the session being published, and everything else", () => {
		publishSessionSink("session-a")
		recordTraceId("trace-a")
		publishSessionSink("session-b")
		recordTraceId("trace-b")

		// Rotation prunes the outgoing session — its `ended` row has already read
		// its ids by the time the sink is republished. Without this a long-lived
		// tab keeps one Set per rotation forever.
		expect(getObservedTraceIds("session-a")).toEqual([])
		expect(getObservedTraceIds("session-b")).toEqual(["trace-b"])
	})

	it("ignores ids recorded with no sink published", () => {
		expect(() => recordTraceId("orphan")).not.toThrow()
		expect(getObservedTraceIds()).toEqual([])
	})

	it("caps retained ids so the ended row can't outgrow the keepalive budget", () => {
		publishSessionSink("session-a")
		for (let i = 0; i < 500; i++) recordTraceId(`trace-${i}`)

		const ids = getObservedTraceIds("session-a")
		expect(ids).toHaveLength(200)
		// Keep-first: the ids are a join key the UI paginates anyway, and a session
		// that runs for hours must not grow an unbounded Set behind it.
		expect(ids[0]).toBe("trace-0")
		expect(ids).not.toContain("trace-499")
	})

	it("still dedupes ids already held once the cap is reached", () => {
		publishSessionSink("session-a")
		for (let i = 0; i < 300; i++) recordTraceId(`trace-${i}`)
		recordTraceId("trace-0")

		expect(getObservedTraceIds("session-a")).toHaveLength(200)
	})
})

describe("clearSessionSink", () => {
	it("removes the sink and forgets its trace ids", () => {
		publishSessionSink("session-a")
		recordTraceId("trace-a")

		clearSessionSink("session-a")

		expect(readSessionSink()).toBeUndefined()
		expect(getObservedTraceIds("session-a")).toEqual([])
	})

	it("leaves a newer sink alone when a stale owner shuts down", () => {
		publishSessionSink("session-a")
		publishSessionSink("session-b")
		recordTraceId("trace-b")

		// The outgoing runtime's shutdown races the new one's start; it must not
		// tear down the session that replaced it.
		clearSessionSink("session-a")

		expect(readSessionSink()?.sessionId).toBe("session-b")
		expect(getObservedTraceIds("session-b")).toEqual(["trace-b"])
	})

	it("clears unconditionally when no session id is given", () => {
		publishSessionSink("session-a")
		clearSessionSink()
		expect(readSessionSink()).toBeUndefined()
	})
})
