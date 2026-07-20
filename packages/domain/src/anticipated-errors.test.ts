import { describe, expect, it } from "vitest"
import { ANTICIPATED_ERROR_IDENTIFIERS, isAnticipatedErrorIdentifier } from "./anticipated-errors"

describe("ANTICIPATED_ERROR_IDENTIFIERS", () => {
	it("includes legacy tags and v2 ErrorClass names for 4xx business errors", () => {
		for (const identifier of [
			"@maple/http/errors/UnauthorizedError",
			"@maple/http/errors/RawSqlValidationError",
			"@maple/http/ai-triage/AiTriageNotFoundError",
			"@maple/http/errors/IntegrationsNotConnectedError",
			"@maple/http/v2/InvalidRequestError",
			"@maple/http/v2/AuthenticationError",
			"@maple/http/v2/RateLimitError",
		]) {
			expect(isAnticipatedErrorIdentifier(identifier), identifier).toBe(true)
		}
	})

	it("excludes 5xx persistence / upstream failures", () => {
		for (const identifier of [
			"@maple/http/errors/WarehouseQueryError",
			"@maple/http/errors/QueryEngineTimeoutError",
			"@maple/http/v2/ApiError",
			"@maple/http/v2/ServiceUnavailableError",
		]) {
			expect(isAnticipatedErrorIdentifier(identifier), identifier).toBe(false)
		}
	})

	it("derives a non-trivial set (reflection still works)", () => {
		expect(ANTICIPATED_ERROR_IDENTIFIERS.size).toBeGreaterThan(25)
	})
})
