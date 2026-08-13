import { Cause } from "effect"
import { HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { QueryEngineExecutionError, WarehouseQuotaExceededError } from "@maple/domain"
import {
	NetworkErrorTag,
	UnexpectedErrorTag,
	displayError,
	isAutomaticRetryError,
	isUnexpectedError,
	publicError,
} from "./error-messages"

const errorEnvelope = (
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

describe("publicError", () => {
	it("returns the public body without translating it", () => {
		const input = errorEnvelope({
			_tag: "@maple/http/errors/InvalidTimeRangeError",
			type: "invalid_request_error",
			code: "invalid_time_range",
			title: "Invalid time range",
			message: "End time must be after start time.",
			recovery: "fix_request",
			param: "end_time",
			retry_after_seconds: 15,
			retry_at: "2026-08-10T00:00:00.000Z",
		})

		expect(publicError(input)).toBe(input.error)
		expect(publicError(input.error)).toBe(input.error)
	})

	it("rejects incomplete lookalikes", () => {
		expect(
			publicError({
				error: {
					type: "not_found_error",
					code: "dashboard_not_found",
					message: "No such dashboard.",
				},
			}),
		).toBeNull()
	})
})

describe("displayError", () => {
	it("passes a declared API error through unchanged", () => {
		const input = errorEnvelope({
			_tag: "@maple/http/errors/InvestigationDailyQuotaError",
			type: "rate_limit_error",
			code: "investigation_daily_quota",
			title: "Today's investigation allowance is used up",
			message: "Daily limit of 90 model passes reached.",
			retryable: true,
			recovery: "retry",
		})

		expect(displayError(input)).toBe(input.error)
	})

	it("reads the same body directly from a tagged domain error", () => {
		const error = new WarehouseQuotaExceededError({
			message: "Code: 159. TIMEOUT_EXCEEDED",
			pipeName: "listLogs",
			setting: "max_execution_time",
		})

		expect(displayError(error)).toBe(error.error)
		expect(displayError(error)).toMatchObject({
			_tag: "@maple/http/errors/WarehouseQuotaExceededError",
			code: "warehouse_quota_exceeded",
			title: "Query was too expensive",
			message: "Query exceeded the 30s execution limit. Narrow the time range or add filters.",
			recovery: "fix_request",
		})
	})

	it("lets the tagged error redact its internal details", () => {
		const error = new QueryEngineExecutionError({
			message: "errorsByType query failed",
			causeMessage: "Code: 226. DB::Exception: Syntax error",
		})

		expect(displayError(error)).toMatchObject({
			title: "Query failed",
			message: "The aggregation query could not be completed.",
		})
	})

	it("finds a declared error in an Effect cause", () => {
		const input = errorEnvelope({
			_tag: "@maple/http/errors/DashboardNotFoundError",
			type: "not_found_error",
			code: "dashboard_not_found",
			title: "Dashboard not found",
			message: "No such dashboard.",
			recovery: "none",
		})

		expect(displayError(Cause.fail(input))).toBe(input.error)
	})

	it("expresses typed transport failures in the public contract", () => {
		const error = new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request: HttpClientRequest.get("https://api.maple.dev/v2/services"),
			}),
		})
		const displayed = displayError(error)

		expect(displayed).toEqual({
			_tag: NetworkErrorTag,
			type: "api_error",
			code: "network_unreachable",
			title: "Cannot reach Maple API",
			message: "Check your connection. Data will resume once the API is reachable.",
			retryable: true,
			recovery: "retry",
		})
		expect(isAutomaticRetryError(displayed)).toBe(true)
	})

	it("automatically retries typed transport timeouts declared retryable", () => {
		const error = new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request: HttpClientRequest.get("https://api.maple.dev/v2/services"),
				cause: new DOMException("timed out", "TimeoutError"),
			}),
		})
		const displayed = displayError(error)

		expect(displayed).toMatchObject({
			_tag: "@maple/web/errors/TimeoutError",
			message: "The API did not respond in time. Try again when you're ready.",
			recovery: "retry",
		})
		expect(isAutomaticRetryError(displayed)).toBe(true)
	})

	it("automatically retries decoded v2 failures only when the body opts in", () => {
		const retryable = displayError(
			errorEnvelope({
				_tag: "@maple/http/errors/WarehouseUpstreamError",
				retryable: true,
				recovery: "retry",
			}),
		)
		expect(isAutomaticRetryError(retryable)).toBe(true)
		expect(isAutomaticRetryError(displayError(errorEnvelope()))).toBe(false)
	})

	it("does not interpret raw tags or human-readable messages", () => {
		for (const error of [
			{ _tag: "@maple/http/errors/DashboardNotFoundError", message: "No such dashboard." },
			new Error("Failed to fetch"),
			new Error("request timed out"),
		]) {
			expect(displayError(error)._tag).toBe(UnexpectedErrorTag)
		}
	})

	it("keeps unknown text out of the public fallback", () => {
		const displayed = displayError("postgres://secret@internal:5432 failed")

		expect(isUnexpectedError(displayed)).toBe(true)
		expect(displayed.message).not.toContain("postgres")
	})

	it("represents stale chunks in the same public contract", () => {
		expect(
			displayError(new Error("Failed to fetch dynamically imported module: /assets/settings.js")),
		).toEqual({
			_tag: "@maple/web/errors/StaleChunkError",
			type: "api_error",
			code: "stale_chunk",
			title: "Maple was updated",
			message: "Reload to use the latest version.",
			retryable: false,
			recovery: "refresh",
		})
	})
})
