import { describe, expect, it } from "vitest"
import { WarehouseQuotaExceededError } from "@maple/domain/http"
import { WarehouseDecodeError, WarehouseQueryError, normalizeWarehouseError } from "./effect-utils"

describe("normalizeWarehouseError", () => {
	it("preserves a v2 error envelope", () => {
		const quota = new WarehouseQuotaExceededError({
			message: "internal",
			pipeName: "getReplayEvents",
			setting: "max_execution_time",
		})
		const error = {
			error: quota.error,
		}
		expect(normalizeWarehouseError("getReplayEvents", error)).toBe(error)
	})

	it("preserves self-describing backend and local warehouse errors", () => {
		const backend = new WarehouseQuotaExceededError({
			message: "internal",
			pipeName: "query",
			setting: "max_memory_usage",
		})
		const local = new WarehouseDecodeError({ operation: "decode", message: "invalid input" })
		expect(normalizeWarehouseError("query", backend)).toBe(backend)
		expect(normalizeWarehouseError("query", local)).toBe(local)
		expect(local.error.title).toBe("Query data could not be read")
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
