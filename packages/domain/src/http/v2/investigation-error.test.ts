import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { InvestigationId, IsoDateTimeString } from "../../primitives"
import {
	InvestigationAgentUnavailableError,
	InvestigationAutomationDisabledError,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	InvestigationQuotaError,
	InvestigationRejectedError,
	InvestigationStartFailedError,
	InvestigationValidationError,
} from "../investigations"
import { toV2Error } from "./public-error"

const map = toV2Error
const retryableAt = Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-12T00:00:00.000Z")
const investigationId = Schema.decodeUnknownSync(InvestigationId)("00000000-0000-0000-0000-000000000000")

describe("investigation public errors", () => {
	it("preserves each unique domain tag in the public envelope", () => {
		const errors = [
			new InvestigationPersistenceError({ message: "db failed" }),
			new InvestigationValidationError({ message: "invalid" }),
			new InvestigationNotFoundError({ message: "missing" }),
			new InvestigationQuotaError({
				message: "quota",
				dimension: "runs",
				limit: 10,
				retryableAt,
			}),
			new InvestigationAutomationDisabledError({ message: "disabled" }),
			new InvestigationAgentUnavailableError({ message: "agent unavailable" }),
			new InvestigationStartFailedError({ message: "start failed" }),
			new InvestigationRejectedError({ message: "rejected", status: 401 }),
			new InvestigationDataCorruptionError({
				message: "invalid stored trace id",
				investigationId,
				field: "report.trace_id",
				value: "invalid",
			}),
		] as const

		for (const error of errors) {
			expect(map(error).error._tag).toBe(error._tag)
		}
	})

	it("derives retry and recovery from the semantic tag", () => {
		const disabled = map(new InvestigationAutomationDisabledError({ message: "disabled" }))
		expect(disabled.error.retryable).toBe(false)
		expect(disabled.error.recovery).toBe("none")

		const unavailable = map(new InvestigationAgentUnavailableError({ message: "agent unavailable" }))
		expect(unavailable.error.retryable).toBe(true)
		expect(unavailable.error.recovery).toBe("retry")

		const rejected = map(new InvestigationRejectedError({ message: "rejected", status: 401 }))
		expect(rejected.error.retryable).toBe(false)
		expect(rejected.error.recovery).toBe("reconnect")
	})

	it("uses tag-owned codes and retains the absolute quota reset", () => {
		const persistence = map(new InvestigationPersistenceError({ message: "private db url" }))
		expect(persistence.error.code).toBe("investigations_unavailable")
		expect(persistence.error.message).not.toContain("private db url")

		const quota = map(
			new InvestigationQuotaError({
				message: "quota",
				dimension: "passes",
				limit: 90,
				retryableAt,
			}),
		)
		expect(quota.error.retry_at).toBe("2026-08-12T00:00:00.000Z")
	})
})
