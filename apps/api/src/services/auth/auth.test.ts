import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { RoleName } from "@maple/domain/http"
import { isAdmin, requireAdmin } from "./auth"

const role = (raw: string) => Schema.decodeUnknownSync(RoleName)(raw)

class TestForbiddenError extends Error {
	readonly _tag = "TestForbiddenError"
}

describe("isAdmin", () => {
	it("returns true for root", () => {
		expect(isAdmin([role("root")])).toBe(true)
	})
	it("returns true for org:admin", () => {
		expect(isAdmin([role("org:admin")])).toBe(true)
	})
	it("returns true if any role is admin", () => {
		expect(isAdmin([role("org:member"), role("root")])).toBe(true)
	})
	it("returns false for non-admin only", () => {
		expect(isAdmin([role("org:member")])).toBe(false)
	})
	it("returns false for empty roles", () => {
		expect(isAdmin([])).toBe(false)
	})
})

describe("requireAdmin", () => {
	it.effect("succeeds when at least one role is admin", () =>
		requireAdmin([role("root")], () => new TestForbiddenError("nope")),
	)

	it.effect("fails with the supplied error for non-admin roles", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				requireAdmin([role("org:member")], () => new TestForbiddenError("nope")),
			)
			assert.instanceOf(error, TestForbiddenError)
		}),
	)
})
