import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { WAREHOUSE_ERROR_TAGS } from "@maple/domain"
import { formatBackendError, humanizeInstants, normalizeAppError, v2ErrorInfo } from "./error-messages"

describe("humanizeInstants", () => {
	const NOW = Date.parse("2026-08-09T17:00:00.000Z")

	it("rewrites an ISO instant as a relative time, keeping the sentence", () => {
		expect(
			humanizeInstants(
				"Daily limit of 90 model passes reached. Resets at 2026-08-10T00:00:00.000Z.",
				NOW,
			),
		).toBe("Daily limit of 90 model passes reached. Resets in 7h.")
	})

	it("leaves a message without an instant alone", () => {
		expect(humanizeInstants("No such investigation.", NOW)).toBe("No such investigation.")
	})
})

describe("formatBackendError", () => {
	/**
	 * The v2 envelope is checked first, and its message is the whole point: a
	 * hardcoded toast title threw away which ceiling was hit and when it resets.
	 */
	it("surfaces a v2 rate-limit message as the description", () => {
		const result = formatBackendError({
			error: {
				type: "rate_limit_error",
				code: "investigation_daily_quota",
				message: "Daily limit of 90 model passes reached. Resets at 2026-08-10T00:00:00.000Z.",
			},
		})
		expect(result.title).toBe("Investigation limit reached")
		expect(result.description).toContain("Daily limit of 90 model passes reached")
		expect(result.description).not.toContain("2026-08-10T00:00:00.000Z")
		expect(result.category).toBe("rate-limit")
		expect(result.code).toBe("investigation_daily_quota")
		expect(result.recovery).toEqual({ kind: "retry", automatic: false })
	})

	it("trusts the backend tag, title, and recovery instead of inferring from status", () => {
		const result = normalizeAppError({
			error: {
				_tag: "@maple/http/errors/WarehouseQuotaExceededError",
				type: "rate_limit_error",
				code: "rate_limited",
				title: "Query was too expensive",
				message: "Narrow the time range or add filters.",
				retryable: false,
				recovery: "fix_request",
				retry_after_seconds: 15,
			},
		})
		expect(result.title).toBe("Query was too expensive")
		expect(result.recovery).toEqual({ kind: "fix-input" })
		expect(result.retryAfterSeconds).toBe(15)
		expect(result.tag).toBe("@maple/http/errors/WarehouseQuotaExceededError")
		expect(result.diagnostics.tag).toBe("@maple/http/errors/WarehouseQuotaExceededError")
	})

	it("uses an explicit non-retryable flag even during a partial metadata rollout", () => {
		const result = formatBackendError({
			error: {
				type: "rate_limit_error",
				code: "query_limit",
				message: "Narrow the query before trying again.",
				retryable: false,
			},
		})
		expect(result.recovery).toEqual({ kind: "none" })
	})

	it("keeps v2 parameter and documentation metadata for field-level UI", () => {
		const input = {
			error: {
				type: "invalid_request_error",
				code: "invalid_time_range",
				message: "End time must be after start time.",
				param: "end_time",
				doc_url: "https://api.maple.dev/v2/docs#time-range",
			},
		}
		expect(v2ErrorInfo(input)).toMatchObject({
			code: "invalid_time_range",
			param: "end_time",
			docUrl: "https://api.maple.dev/v2/docs#time-range",
		})
		expect(formatBackendError(input)).toMatchObject({
			category: "validation",
			param: "end_time",
			recovery: { kind: "fix-input", param: "end_time" },
		})
	})

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

	it("keeps the engine's message as the title and details as the description", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/QueryEngineValidationError",
			message: "List query time range too large",
			details: ["List queries support a maximum range of 7 days", "Narrow the time range"],
		})
		// The specific headline used to be discarded in favour of a generic
		// "Invalid query parameters" whenever details were present.
		expect(result.title).toBe("List query time range too large")
		expect(result.description).toBe(
			"List queries support a maximum range of 7 days; Narrow the time range",
		)
	})

	it("falls back to the message as the description when there are no details", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/QueryEngineValidationError",
			message: "Invalid time range",
			details: [],
		})
		expect(result.title).toBe("Invalid time range")
		expect(result.description).toBe("Invalid time range")
	})

	it("redacts QueryEngineExecutionError causeMessage from display copy", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/QueryEngineExecutionError",
			message: "errorsByType query failed",
			causeMessage: "Code: 226. DB::Exception: Syntax error",
		})
		expect(result.title).toBe("Query failed")
		expect(result.description).not.toContain("errorsByType")
		expect(result.description).not.toContain("Syntax error")
	})

	it("formats WarehouseQueryError without leaking the internal pipe label", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseQueryError",
			message: "DB::Exception: syntax error",
			pipe: "spanHierarchy",
		})
		expect(result.title).toBe("Database query failed")
		expect(result.description).toBe("Database query failed")
		expect(result.description).not.toContain("DB::Exception")
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
		expect(result.description).toBe("Database is not configured correctly.")
		expect(result.description).not.toContain("default")
	})

	it("formats WarehouseClientError as a decode issue", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseClientError",
			message: "Unexpected token '<'",
			pipe: "sqlQuery",
		})
		expect(result.title).toBe("Database response could not be decoded")
		expect(result.description).toBe("Database response could not be decoded.")
		expect(result.description).not.toContain("Unexpected token")
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

	it("formats decode-kind WarehouseSchemaDriftError without the schema-apply hint", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseSchemaDriftError",
			message: "Compiled query row 0 did not match its declared output schema",
			kind: "decode",
			pipe: "serviceOverview",
		})
		expect(result.description).not.toContain("schema apply")
		expect(result.description).toContain("Maple bug")
	})

	it("formats WarehouseMalformedQueryError as a Maple bug, not a database problem", () => {
		const result = formatBackendError({
			_tag: "@maple/http/errors/WarehouseMalformedQueryError",
			message: "NO_COMMON_TYPE: There is no supertype for types UInt64, Float64",
			pipe: "traces_timeseries",
		})
		expect(result.title).toBe("This chart hit a bug in Maple")
		expect(result.description).toContain("our fault")
		expect(result.description).not.toContain("schema apply")
	})

	it("gives every warehouse tag a specific title", () => {
		for (const tag of WAREHOUSE_ERROR_TAGS) {
			const result = formatBackendError({ _tag: tag, message: "boom" })
			expect(result.title, tag).not.toBe("Something went wrong")
		}
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
		expect(result.description).toBe("Database query failed")
		expect(result.description).not.toContain("DB::Exception")
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
		expect(result.title).toBe("Sign in required")
		expect(result.recovery).toEqual({ kind: "reauth" })
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
		expect(result.recovery).toEqual({ kind: "retry", automatic: true })
	})

	it("treats client abort timeouts as manual retry, not connectivity polling", () => {
		const error = new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request: HttpClientRequest.get("https://api.maple.dev/v1/services"),
				cause: new DOMException("timed out", "TimeoutError"),
			}),
		})
		const result = formatBackendError(error)
		expect(result.category).toBe("timeout")
		expect(result.kind).toBeUndefined()
		expect(result.recovery).toEqual({ kind: "retry", automatic: false })
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
		expect(result.description).not.toContain("boom")
		expect(result.recognized).toBe(false)
	})

	it("falls back for unknown shapes", () => {
		expect(formatBackendError("string error").description).not.toContain("string error")
		expect(formatBackendError(null).title).toBe("Something went wrong")
		expect(formatBackendError(undefined).title).toBe("Something went wrong")
	})

	it("reads message from object-shaped errors without _tag", () => {
		const result = formatBackendError({ message: "raw message" })
		expect(result.title).toBe("Something went wrong")
		expect(result.description).not.toContain("raw message")
	})

	it("retains raw technical text only in diagnostics", () => {
		const result = normalizeAppError({
			_tag: "@maple/http/errors/DatabaseError",
			message: "postgres://secret@internal:5432 failed",
		})
		expect(result.description).not.toContain("postgres")
		expect(result.diagnostics.technicalMessage).toContain("postgres://secret")
	})

	it("finds a structured API failure nested under a generic cause", () => {
		const result = formatBackendError({
			message: "request wrapper failed",
			cause: {
				error: {
					type: "not_found_error",
					code: "dashboard_not_found",
					message: "No such dashboard.",
				},
			},
		})
		expect(result).toMatchObject({
			title: "Not found",
			category: "not-found",
			code: "dashboard_not_found",
		})
	})
})
