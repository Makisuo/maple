import { describe, expect, it } from "vitest"
import { ANTICIPATED_ERROR_TAGS, isAnticipatedErrorTag } from "./anticipated-errors"

describe("ANTICIPATED_ERROR_TAGS", () => {
	it("includes the observed 4xx business-error tags", () => {
		for (const tag of [
			"@maple/http/errors/UnauthorizedError",
			"@maple/http/errors/RawSqlValidationError",
			"@maple/http/ai-triage/AiTriageNotFoundError",
			"@maple/http/errors/IntegrationsNotConnectedError",
		]) {
			expect(isAnticipatedErrorTag(tag), tag).toBe(true)
		}
	})

	it("excludes 5xx persistence / upstream failures", () => {
		for (const tag of [
			"@maple/http/errors/WarehouseQueryError",
			"@maple/http/errors/QueryEngineTimeoutError",
		]) {
			expect(isAnticipatedErrorTag(tag), tag).toBe(false)
		}
	})

	it("derives a non-trivial set (reflection still works)", () => {
		expect(ANTICIPATED_ERROR_TAGS.size).toBeGreaterThan(20)
	})
})
