import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { formatBackendError } from "./error-messages"

describe("formatBackendError", () => {
	it("formats WarehouseQuotaExceededError with execution time setting", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQuotaExceededError",
			message: "Code: 159. TIMEOUT_EXCEEDED",
			pipe: "listLogs",
			setting: "max_execution_time",
		})
		expect(result.title).toBe("Query was too expensive")
		expect(result.description).toContain("30s execution limit")
	})

	it("formats WarehouseQuotaExceededError with memory setting", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQuotaExceededError",
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

	it("formats WarehouseQueryError without leaking the internal pipe label", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message: "DB::Exception: syntax error",
			pipe: "spanHierarchy",
		})
		expect(result.title).toBe("Database query failed")
		expect(result.description).toBe("DB::Exception: syntax error")
		expect(result.description).not.toContain("spanHierarchy")
	})

	it("formats WarehouseUpstreamError as transient", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseUpstreamError",
			message: "Request failed with status 503",
			pipe: "listLogs",
			upstreamStatus: 503,
		})
		expect(result.title).toBe("Database is temporarily unavailable")
		expect(result.description).toContain("503")
	})

	it("formats WarehouseAuthError as a credentials issue", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseAuthError",
			message: "Request failed with status 401",
			pipe: "listLogs",
			upstreamStatus: 401,
		})
		expect(result.title).toBe("Database rejected our credentials")
		expect(result.description).toContain("invalid or expired")
	})

	it("formats WarehouseConfigError as a configuration issue", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseConfigError",
			message: "Database default does not exist",
			pipe: "sqlQuery",
			clickhouseType: "UNKNOWN_DATABASE",
		})
		expect(result.title).toBe("Database is not configured correctly")
		expect(result.description).toContain("Database default does not exist")
	})

	it("formats WarehouseClientError as a decode issue", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseClientError",
			message: "Unexpected token '<'",
			pipe: "sqlQuery",
		})
		expect(result.title).toBe("Database response could not be decoded")
		expect(result.description).toContain("Unexpected token")
	})

	it("formats WarehouseSchemaDriftError with a schema-apply hint", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseSchemaDriftError",
			message: "Unknown identifier 'SampleRate'",
			pipe: "service_overview",
		})
		expect(result.title).toBe("Database schema is out of date")
		expect(result.description).toContain("schema apply")
	})

	it("formats WarehouseValidationError as an invalid query", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseValidationError",
			message: "SQL query must contain OrgId filter",
			pipe: "sqlQuery",
		})
		expect(result.title).toBe("Invalid query")
		expect(result.description).toContain("OrgId")
	})

	it("rewrites WarehouseQueryError when message leaks a 5xx status", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message: "Request failed with status 521: error code: 521",
			pipe: "sqlQuery",
		})
		expect(result.title).toBe("Database is temporarily unavailable")
		expect(result.description).toContain("521")
	})

	it("does not leak the (sqlQuery) pipe suffix", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message: "DB::Exception: out of memory",
			pipe: "sqlQuery",
		})
		expect(result.description).not.toContain("sqlQuery")
		expect(result.description).toBe("DB::Exception: out of memory")
	})

	it("strips raw nginx HTML and converts leaked 503 to a friendly message", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message:
				"Request failed with status 503: <html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>",
			pipe: "sqlQuery",
		})
		expect(result.description).not.toContain("<html>")
		expect(result.description).not.toContain("<title>")
		expect(result.title).toBe("Database is temporarily unavailable")
		expect(result.description).toContain("503")
	})

	it("formats UnauthorizedError", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/UnauthorizedError",
		})
		expect(result.title).toBe("Not authorized")
	})

	it("tags transport HttpClientError as a network error", () => {
		const error = new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request: HttpClientRequest.get("https://api.maple.dev/v1/services"),
			}),
		})
		const result = formatBackendError(error)
		expect(result.title).toBe("Cannot reach Maple API")
		expect(result.kind).toBe("network")
	})

	it("tags fetch-failure Error messages as network errors", () => {
		const result = formatBackendError(new Error("Failed to fetch"))
		expect(result.title).toBe("Cannot reach Maple API")
		expect(result.kind).toBe("network")
	})

	it("does not tag non-network errors", () => {
		expect(formatBackendError(new Error("boom")).kind).toBeUndefined()
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
