import { describe, expect, it } from "vitest"
import { formatBackendError } from "./error-messages"

describe("formatBackendError", () => {
	it("formats TinybirdQuotaExceededError with execution time setting", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/TinybirdQuotaExceededError",
			message: "Code: 159. TIMEOUT_EXCEEDED",
			pipe: "listLogs",
			setting: "max_execution_time",
		})
		expect(result.title).toBe("Query was too expensive")
		expect(result.description).toContain("30s execution limit")
	})

	it("formats TinybirdQuotaExceededError with memory setting", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/TinybirdQuotaExceededError",
			message: "memory limit",
			pipe: "listTraces",
			setting: "max_memory_usage",
		})
		expect(result.title).toBe("Query was too expensive")
		expect(result.description).toContain("memory")
	})

	it("formats QueryEngineTimeoutError", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/QueryEngineTimeoutError",
			message: "took too long",
		})
		expect(result.title).toBe("Query timed out")
		expect(result.description).toContain("30 seconds")
	})

	it("formats QueryEngineValidationError with details", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/QueryEngineValidationError",
			message: "invalid",
			details: ["startTime must be before endTime", "limit too high"],
		})
		expect(result.title).toBe("Invalid query parameters")
		expect(result.description).toBe("startTime must be before endTime; limit too high")
	})

	it("formats QueryEngineExecutionError with causeMessage", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/QueryEngineExecutionError",
			message: "errorsByType query failed",
			causeMessage: "Code: 226. DB::Exception: Syntax error",
		})
		expect(result.title).toBe("Query failed")
		expect(result.description).toContain("errorsByType query failed")
		expect(result.description).toContain("Syntax error")
	})

	it("formats TinybirdQueryError", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/TinybirdQueryError",
			message: "DB::Exception: error",
			pipe: "spanHierarchy",
		})
		expect(result.title).toBe("Database query failed")
		expect(result.description).toContain("DB::Exception")
		expect(result.description).toContain("spanHierarchy")
	})

	it("formats UnauthorizedError", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/UnauthorizedError",
		})
		expect(result.title).toBe("Not authorized")
	})

	it("falls back for plain Error", () => {
		const result = formatBackendError(new Error("boom"))
		expect(result.title).toBe("Something went wrong")
		expect(result.description).toBe("boom")
	})

	it("falls back for unknown shapes", () => {
		expect(formatBackendError("string error").description).toBe("string error")
		expect(formatBackendError(null).title).toBe("Something went wrong")
		expect(formatBackendError(undefined).title).toBe("Something went wrong")
	})

	it("reads message from object-shaped errors without _tag", () => {
		const result = formatBackendError({ message: "raw message" })
		expect(result.title).toBe("Something went wrong")
		expect(result.description).toBe("raw message")
	})
})
