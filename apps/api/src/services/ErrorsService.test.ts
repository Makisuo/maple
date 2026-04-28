import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ErrorPersistenceError } from "@maple/domain/http"
import { describeCause, makePersistenceError } from "./ErrorsService"

describe("makePersistenceError", () => {
	it("omits the cause key when the source has no cause", () => {
		const err = makePersistenceError(new Error("boom"))
		expect("cause" in err).toBe(false)
		expect(err.message).toBe("boom")
	})

	it("includes cause when the source carries one", () => {
		const inner = new Error("inner")
		const outer = new Error("boom", { cause: inner })
		const err = makePersistenceError(outer)
		expect(typeof err.cause).toBe("string")
		expect(err.cause).toContain("inner")
	})

	it("survives a Schema round-trip when cause is absent", async () => {
		const err = makePersistenceError(new Error("boom"))
		const encoded = Schema.encodeSync(ErrorPersistenceError)(err)
		const decoded = Schema.decodeUnknownSync(ErrorPersistenceError)(encoded)
		expect("cause" in decoded).toBe(false)
		expect(decoded.message).toBe("boom")
	})
})

describe("describeCause", () => {
	it("returns undefined for null/undefined", () => {
		expect(describeCause(null)).toBeUndefined()
		expect(describeCause(undefined)).toBeUndefined()
	})

	it("returns the message/stack for Error instances", () => {
		const e = new Error("x")
		expect(describeCause(e)).toContain("x")
	})

	it("returns the string itself for string causes", () => {
		expect(describeCause("oops")).toBe("oops")
	})
})
