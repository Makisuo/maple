import { describe, expect, it } from "vitest"
import { WarehouseDecodeError, WarehouseQueryError, normalizeWarehouseError } from "./effect-utils"

describe("normalizeWarehouseError", () => {
	it("preserves a v2 error envelope", () => {
		const error = {
			error: {
				type: "invalid_request_error",
				code: "range_too_large",
				message: "Narrow the chunk range.",
			},
		}
		expect(normalizeWarehouseError("getReplayEvents", error)).toBe(error)
	})

	it("preserves tagged backend and local warehouse errors", () => {
		const backend = { _tag: "@maple/http/errors/WarehouseQuotaExceededError", message: "quota" }
		const local = new WarehouseDecodeError({ operation: "decode", message: "invalid input" })
		expect(normalizeWarehouseError("query", backend)).toBe(backend)
		expect(normalizeWarehouseError("query", local)).toBe(local)
	})

	it("wraps an unstructured failure exactly once", () => {
		const cause = new Error("transport failed")
		const normalized = normalizeWarehouseError("query", cause)
		expect(normalized).toBeInstanceOf(WarehouseQueryError)
		if (!(normalized instanceof WarehouseQueryError)) throw new Error("expected WarehouseQueryError")
		expect(normalized.message).toBe("transport failed")
		expect(normalized.cause).toBe(cause)
		expect(normalizeWarehouseError("query", normalized)).toBe(normalized)
	})
})
