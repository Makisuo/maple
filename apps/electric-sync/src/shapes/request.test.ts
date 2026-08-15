import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { decodeSyncRequest } from "./request"

const decode = (query: string) => decodeSyncRequest(new URLSearchParams(query))

const expectFailure = (query: string) => {
	const result = decode(query)
	assert.isTrue(Result.isFailure(result), query)
	if (!Result.isFailure(result)) throw new Error("unreachable")
	return result.failure
}

const expectSuccess = (query: string) => {
	const result = decode(query)
	assert.isTrue(Result.isSuccess(result), query)
	if (!Result.isSuccess(result)) throw new Error("unreachable")
	return result.success
}

describe("decodeShapeRequest", () => {
	it("accepts a whitelisted org-wide shape", () => {
		const request = expectSuccess("shape=dashboards&offset=-1")
		assert.strictEqual(request.shape, "dashboards")
		assert.isNull(request.scope)
		assert.strictEqual(request.clientParams.get("offset"), "-1")
	})

	it("rejects an unknown or missing shape", () => {
		assert.strictEqual(expectFailure("shape=users").message, "Unknown or missing shape")
		assert.strictEqual(expectFailure("offset=-1").message, "Unknown or missing shape")
	})

	/**
	 * A scoped shape asked for without its scope must NOT quietly fall back to the
	 * org-wide stream it exists to avoid — that would sync an org's whole
	 * investigation history to render one page.
	 */
	it("rejects a scoped shape that arrives without a usable scope", () => {
		assert.strictEqual(
			expectFailure("shape=investigation&offset=-1").message,
			"Shape investigation requires a scope",
		)
		assert.strictEqual(expectFailure("shape=investigation&scope=").message.length > 0, true)
		assert.strictEqual(
			expectFailure(`shape=investigation_lens_runs&scope=${"x".repeat(129)}`).message,
			"Shape investigation_lens_runs requires a scope",
		)
	})

	/**
	 * The value arrives already paired with the column it will be compared against,
	 * which is the whole point: a caller cannot receive one without the other, so
	 * the URL builder has no "scoped shape, no value" case to fall through.
	 */
	it("pairs the scope value with its pinned column", () => {
		assert.deepStrictEqual(expectSuccess("shape=investigation&scope=inv_1").scope, {
			column: "id",
			value: "inv_1",
		})
		assert.deepStrictEqual(expectSuccess("shape=investigation_lens_runs&scope=inv_1").scope, {
			column: "investigation_id",
			value: "inv_1",
		})
	})

	/**
	 * An org-wide shape has no scope column, so a `scope` param is meaningless.
	 * Dropping it here means nothing downstream can mistake it for one.
	 */
	it("drops a stray scope on an org-wide shape rather than passing it on", () => {
		assert.isNull(expectSuccess("shape=dashboards&scope=inv_1").scope)
	})
})
