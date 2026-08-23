import { describe, expect, it } from "vitest"
import { ANTICIPATED_ERROR_IDENTIFIERS, isAnticipatedErrorIdentifier } from "./anticipated-errors"
import { deriveAnticipatedIdentifiers } from "./anticipated-errors-derive"

describe("ANTICIPATED_ERROR_IDENTIFIERS", () => {
	it("matches the reflection-derived set", () => {
		expect([...ANTICIPATED_ERROR_IDENTIFIERS].sort()).toEqual([...deriveAnticipatedIdentifiers()].sort())
	})

	it("includes exact tagged-error identifiers for 4xx business errors", () => {
		for (const identifier of [
			"@maple/http/errors/UnauthorizedError",
			"@maple/http/errors/RawSqlValidationError",
			"@maple/http/errors/IntegrationsNotConnectedError",
			"@maple/http/v2/InvalidRequestError",
			"@maple/http/v2/InvalidCredentialsError",
			"@maple/http/v2/RateLimitError",
		]) {
			expect(isAnticipatedErrorIdentifier(identifier), identifier).toBe(true)
		}
	})

	it("excludes 5xx persistence / upstream failures", () => {
		for (const identifier of [
			"@maple/http/errors/WarehouseQueryError",
			"@maple/http/errors/QueryEngineTimeoutError",
			"@maple/http/v2/UnexpectedError",
			"@maple/http/v2/WorkerUnavailableError",
		]) {
			expect(isAnticipatedErrorIdentifier(identifier), identifier).toBe(false)
		}
	})

	it("contains a non-trivial generated set", () => {
		expect(ANTICIPATED_ERROR_IDENTIFIERS.size).toBeGreaterThan(25)
	})
})
