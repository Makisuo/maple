import { assert, describe, it } from "@effect/vitest"
import { AlertDestinationId, type IssueEscalationPolicyRule } from "@maple/domain/http"
import { Schema } from "effect"
import { evaluateEscalationPolicy } from "./escalation-policy"

const decodeDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const primary = decodeDestinationId("00000000-0000-4000-8000-000000000001")
const disabled = decodeDestinationId("00000000-0000-4000-8000-000000000002")
const rules: ReadonlyArray<IssueEscalationPolicyRule> = [
	{
		severity: "high",
		destinationIds: [primary, disabled],
		minConfidence: "high",
	},
]

describe("evaluateEscalationPolicy", () => {
	it("applies confidence gates to AI decisions", () => {
		assert.deepStrictEqual(
			evaluateEscalationPolicy({
				enabled: true,
				rules,
				severity: "high",
				source: "ai",
				confidence: "medium",
			}),
			{ outcome: "skip", destinationIds: [], skipReason: "below_min_confidence" },
		)
	})

	it("treats manual severity as explicit human intent", () => {
		assert.deepStrictEqual(
			evaluateEscalationPolicy({
				enabled: true,
				rules,
				severity: "high",
				source: "manual",
				enabledDestinationIds: new Set([primary]),
			}),
			{ outcome: "route", destinationIds: [primary], skipReason: null },
		)
	})

	it("returns an explicit reason when every matched destination is disabled", () => {
		assert.deepStrictEqual(
			evaluateEscalationPolicy({
				enabled: true,
				rules,
				severity: "high",
				source: "manual",
				enabledDestinationIds: new Set(),
			}),
			{ outcome: "skip", destinationIds: [], skipReason: "no_enabled_destinations" },
		)
	})
})
