import { beforeEach, describe, expect, it } from "vitest"

import {
	isBlipping,
	noteReachable,
	noteUnreachable,
	originOf,
	PEER_OUTAGE_GRACE_MS,
} from "./peer-reachability"

const ORIGIN = "https://api.test"

/**
 * A wifi blip fails every request in flight at the same instant, which is why
 * this measures elapsed time rather than counting failures: on the production
 * session that fired the High error rate alert, four shape long-polls and every
 * API call failed inside two seconds and the session then ran on for another 14
 * minutes. A counter would have escalated on the first of them.
 */
describe("peer reachability", () => {
	beforeEach(() => {
		noteReachable(ORIGIN)
		noteReachable("https://other.test")
	})

	it("starts the clock at zero on the first failure", () => {
		expect(noteUnreachable(ORIGIN, 1_000)).toBe(0)
	})

	it("measures from the first failure, not the previous one", () => {
		noteUnreachable(ORIGIN, 1_000)
		noteUnreachable(ORIGIN, 5_000)

		expect(noteUnreachable(ORIGIN, 9_000)).toBe(8_000)
	})

	it("restarts once the origin answers, so a later blip is a blip again", () => {
		noteUnreachable(ORIGIN, 1_000)
		noteReachable(ORIGIN)

		expect(noteUnreachable(ORIGIN, 60_000)).toBe(0)
	})

	it("tracks each origin separately", () => {
		noteUnreachable(ORIGIN, 1_000)

		expect(noteUnreachable("https://other.test", 20_000)).toBe(0)
	})

	it("reads as blipping only inside the grace window", () => {
		expect(isBlipping(ORIGIN, 1_000)).toBe(false)

		noteUnreachable(ORIGIN, 1_000)

		expect(isBlipping(ORIGIN, 1_000 + PEER_OUTAGE_GRACE_MS - 1)).toBe(true)
		// Past the window the origin is not blipping — it is down, and a failure
		// against it reports as an error again.
		expect(isBlipping(ORIGIN, 1_000 + PEER_OUTAGE_GRACE_MS)).toBe(false)
	})

	it("stops reading as blipping once the origin answers", () => {
		noteUnreachable(ORIGIN, 1_000)
		noteReachable(ORIGIN)

		expect(isBlipping(ORIGIN, 1_001)).toBe(false)
	})
})

describe("originOf", () => {
	it("drops the path and query so one clock covers a whole host", () => {
		expect(originOf("https://api.test/internal/query-engine/execute-batch?x=1")).toBe("https://api.test")
	})

	it("falls back to the raw value when it is not a URL", () => {
		expect(originOf("::::")).toBe("::::")
	})
})
