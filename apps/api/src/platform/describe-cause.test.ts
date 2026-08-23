import { assert, describe, it } from "@effect/vitest"
import { Cause } from "effect"
import { toDatabaseError } from "./DatabaseLive"
import { summarizeCause } from "./describe-cause"

/**
 * A postgres.js connection failure, shaped as the driver actually raises it:
 * the machine-readable class on `code`, and the socket error hung off `cause`
 * with the host and port it was dialing.
 */
const driverConnectionError = (): Error =>
	Object.assign(new Error("write CONNECT_TIMEOUT"), {
		code: "CONNECT_TIMEOUT",
		cause: Object.assign(new Error("connect ETIMEDOUT 10.0.4.19:5432"), {
			code: "ETIMEDOUT",
			address: "10.0.4.19",
			port: 5432,
		}),
	})

describe("summarizeCause", () => {
	it("names a tagged failure by its tag", () => {
		const summary = summarizeCause(Cause.fail(toDatabaseError(new Error("relation does not exist"))))
		assert.strictEqual(summary, "@maple/api/lib/DatabaseError: relation does not exist")
	})

	it("keeps the raw driver object out of the annotation", () => {
		const summary = summarizeCause(Cause.fail(toDatabaseError(driverConnectionError())))
		// `toDatabaseError` deliberately lifts the root cause's *message* into its
		// own, and that stays: which host timed out is the whole diagnostic. What
		// must not follow it is the driver object itself — its `code`, `address`
		// and `port` properties, and every frame of its stack.
		assert.include(summary, "write CONNECT_TIMEOUT")
		assert.include(summary, "connect ETIMEDOUT")
		assert.notInclude(summary, "address")
		assert.notInclude(summary, "[cause]")
	})

	it("carries no stack frames", () => {
		const summary = summarizeCause(Cause.fail(new Error("boom")))
		assert.strictEqual(summary, "Error: boom")
	})

	it("names a defect by its constructor", () => {
		assert.strictEqual(
			summarizeCause(Cause.die(new TypeError("x is not a function"))),
			"TypeError: x is not a function",
		)
	})

	it("reports every reason of a multi-failure cause", () => {
		const cause = Cause.fromReasons([
			...Cause.fail(new Error("first")).reasons,
			...Cause.die(new Error("second")).reasons,
		])
		assert.strictEqual(summarizeCause(cause), "Error: first; Error: second")
	})

	it("caps a statement a warehouse error inlined whole", () => {
		const summary = summarizeCause(Cause.fail(new Error(`syntax error near ${"SELECT x, ".repeat(200)}`)))
		assert.isBelow(summary.length, 550)
		assert.isTrue(summary.endsWith("…[truncated]"))
	})

	it("stays legible for a failure that is not an Error", () => {
		// Effect's own normalizer covers these, which is the reason this module
		// does not hand-roll the narrowing: a thrown string, number, or bare
		// object all still produce something groupable.
		assert.strictEqual(summarizeCause(Cause.fail("plain string failure")), "Error: plain string failure")
		assert.strictEqual(summarizeCause(Cause.fail(42)), "Error: 42")
		assert.strictEqual(summarizeCause(Cause.fail({ message: "objish" })), "Error: objish")
	})

	it("says something rather than nothing for an empty cause", () => {
		assert.strictEqual(summarizeCause(Cause.fromReasons([])), "empty cause")
	})
})
