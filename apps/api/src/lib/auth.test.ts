import { describe, expect, it } from "vitest"
import { Effect, Exit, Option, Schema } from "effect"
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
	it("succeeds when at least one role is admin", () => {
		const exit = Effect.runSyncExit(
			requireAdmin([role("root")], () => new TestForbiddenError("nope")),
		)
		expect(Exit.isSuccess(exit)).toBe(true)
	})

	it("fails with the supplied error for non-admin roles", () => {
		const exit = Effect.runSyncExit(
			requireAdmin([role("org:member")], () => new TestForbiddenError("nope")),
		)
		expect(Exit.isSuccess(exit)).toBe(false)
		const err = Option.getOrUndefined(Exit.findErrorOption(exit))
		expect(err).toBeInstanceOf(TestForbiddenError)
	})
})
