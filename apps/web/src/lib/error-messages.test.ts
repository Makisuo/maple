import { Cause } from "effect"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { QueryEngineExecutionError, WarehouseQuotaExceededError } from "@maple/domain"
import { formatBackendError, humanizeInstants, normalizeAppError, v2ErrorInfo } from "./error-messages"

const publicError = (
	overrides: Partial<{
		_tag: string
		type:
			| "invalid_request_error"
			| "authentication_error"
			| "permission_error"
			| "not_found_error"
			| "conflict_error"
			| "rate_limit_error"
			| "api_error"
		code: string
		title: string
		message: string
		retryable: boolean
		recovery:
			| "none"
			| "fix_request"
			| "reauthenticate"
			| "request_access"
			| "reconnect"
			| "refresh"
			| "retry"
			| "contact_support"
		retry_after_seconds: number
		retry_at: string
		param: string
		doc_url: string
	}> = {},
) => ({
	error: {
		_tag: "@maple/http/v2/test_error",
		type: "api_error" as const,
		code: "test_error",
		title: "Maple could not complete the request",
		message: "Maple could not complete the request.",
		retryable: false,
		recovery: "contact_support" as const,
		...overrides,
	},
})

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
	it("uses the public title, message, and recovery verbatim", () => {
		const result = formatBackendError(
			publicError({
				_tag: "@maple/http/errors/InvestigationDailyQuotaError",
				type: "rate_limit_error",
				code: "investigation_daily_quota",
				title: "Today's investigation allowance is used up",
				message: "Daily limit of 90 model passes reached. Resets at 2026-08-10T00:00:00.000Z.",
				retryable: true,
				recovery: "retry",
			}),
		)

		expect(result.title).toBe("Today's investigation allowance is used up")
		expect(result.description).toContain("Daily limit of 90 model passes reached")
		expect(result.description).not.toContain("2026-08-10T00:00:00.000Z")
		expect(result.category).toBe("rate-limit")
		expect(result.code).toBe("investigation_daily_quota")
		expect(result.recovery).toBe("retry")
		expect(result.automaticRetry).toBe(false)
	})

	it("does not reclassify api_error codes", () => {
		const result = formatBackendError(
			publicError({
				_tag: "@maple/http/errors/WarehouseUpstreamError",
				code: "warehouse_unavailable",
				title: "Database is temporarily unavailable",
				message: "The query backend is unreachable. Retry in a few seconds.",
				retryable: true,
				recovery: "retry",
			}),
		)

		expect(result.category).toBe("server")
		expect(result.title).toBe("Database is temporarily unavailable")
	})

	it("reads the same public body directly from a tagged domain error", () => {
		const error = new WarehouseQuotaExceededError({
			message: "Code: 159. TIMEOUT_EXCEEDED",
			pipeName: "listLogs",
			setting: "max_execution_time",
		})
		const result = formatBackendError(error)

		expect(result).toMatchObject({
			tag: "@maple/http/errors/WarehouseQuotaExceededError",
			code: "warehouse_quota_exceeded",
			title: "Query was too expensive",
			category: "rate-limit",
			recovery: "fix_request",
		})
		expect(result.description).toContain("30s execution limit")
		expect(result.description).not.toContain("TIMEOUT_EXCEEDED")
	})

	it("lets the error class redact internal details", () => {
		const error = new QueryEngineExecutionError({
			message: "errorsByType query failed",
			causeMessage: "Code: 226. DB::Exception: Syntax error",
		})
		const result = formatBackendError(error)

		expect(result.title).toBe("Query failed")
		expect(result.description).toBe("The aggregation query could not be completed.")
		expect(result.description).not.toContain("Syntax error")
	})

	it("keeps public parameter, retry, and documentation metadata", () => {
		const input = publicError({
			_tag: "@maple/http/errors/InvalidTimeRangeError",
			type: "invalid_request_error",
			code: "invalid_time_range",
			title: "Invalid time range",
			message: "End time must be after start time.",
			retryable: false,
			recovery: "fix_request",
			param: "end_time",
			doc_url: "https://api.maple.dev/v2/docs#time-range",
			retry_after_seconds: 15,
			retry_at: "2026-08-10T00:00:00.000Z",
		})

		expect(v2ErrorInfo(input)).toMatchObject({
			code: "invalid_time_range",
			param: "end_time",
			docUrl: "https://api.maple.dev/v2/docs#time-range",
			retryAfterSeconds: 15,
			retryAt: "2026-08-10T00:00:00.000Z",
		})
		expect(formatBackendError(input)).toMatchObject({
			category: "validation",
			param: "end_time",
			recovery: "fix_request",
		})
	})

	it("rejects incomplete public error lookalikes instead of inventing missing policy", () => {
		const input = {
			error: {
				type: "not_found_error",
				code: "dashboard_not_found",
				message: "No such dashboard.",
			},
		}

		expect(v2ErrorInfo(input)).toBeNull()
		expect(formatBackendError(input)).toMatchObject({
			title: "Something went wrong",
			recognized: false,
		})
	})

	it("does not infer presentation from a raw tag suffix", () => {
		const input = {
			_tag: "@maple/http/errors/DashboardNotFoundError",
			message: "postgres://secret@internal:5432 failed",
		}
		const result = normalizeAppError(input)

		expect(result.title).toBe("Something went wrong")
		expect(result.recognized).toBe(false)
		expect(result.diagnostics.tag).toBe(input._tag)
		expect(result.diagnostics.technicalMessage).toBe(input.message)
		expect(result.description).not.toContain("postgres")
	})

	it("finds a complete public error nested in an Effect cause", () => {
		const error = publicError({
			_tag: "@maple/http/errors/DashboardNotFoundError",
			type: "not_found_error",
			code: "dashboard_not_found",
			title: "Dashboard not found",
			message: "No such dashboard.",
			recovery: "none",
		})
		const result = formatBackendError(Cause.fail(error))

		expect(result).toMatchObject({
			title: "Dashboard not found",
			category: "not-found",
			code: "dashboard_not_found",
		})
	})

	it("tags typed HTTP transport failures as network errors", () => {
		const error = new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request: HttpClientRequest.get("https://api.maple.dev/v2/services"),
			}),
		})
		const result = formatBackendError(error)

		expect(result.title).toBe("Cannot reach Maple API")
		expect(result.recovery).toBe("retry")
		expect(result.automaticRetry).toBe(true)
	})

	it("treats typed transport timeouts as manual retries", () => {
		const error = new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request: HttpClientRequest.get("https://api.maple.dev/v2/services"),
				cause: new DOMException("timed out", "TimeoutError"),
			}),
		})
		const result = formatBackendError(error)

		expect(result.category).toBe("timeout")
		expect(result.recovery).toBe("retry")
		expect(result.automaticRetry).toBe(false)
	})

	it("keeps plain errors generic rather than interpreting their message", () => {
		const networkLookalike = formatBackendError(new Error("Failed to fetch"))
		const timeoutLookalike = formatBackendError(new Error("request timed out"))

		expect(networkLookalike).toMatchObject({ title: "Something went wrong", recognized: false })
		expect(timeoutLookalike).toMatchObject({ title: "Something went wrong", recognized: false })
		expect(networkLookalike.automaticRetry).toBe(false)
	})

	it("keeps unknown values and their text out of rendered copy", () => {
		expect(formatBackendError("string error").description).not.toContain("string error")
		expect(formatBackendError(null).title).toBe("Something went wrong")
		expect(formatBackendError(undefined).title).toBe("Something went wrong")
	})

	it("keeps the dedicated stale-chunk recovery", () => {
		const result = formatBackendError(
			new Error("Failed to fetch dynamically imported module: /assets/settings.js"),
		)

		expect(result).toMatchObject({
			title: "Maple was updated",
			recovery: "refresh",
			recognized: true,
		})
	})
})
