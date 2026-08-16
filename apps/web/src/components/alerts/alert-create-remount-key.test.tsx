// @vitest-environment jsdom

import {
	AlertRuleDocument,
	AlertRuleId,
	AlertRulesListResponse,
	IsoDateTimeString,
	UserId,
} from "@maple/domain/http"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { Result } from "@/lib/effect-atom"
import { deriveRuleInitialization } from "./alert-create-page-content"

afterEach(cleanup)

const RULE_A = "11111111-1111-4111-8111-111111111111"
const RULE_B = "22222222-2222-4222-8222-222222222222"

const iso = IsoDateTimeString.make("2026-08-16T00:00:00.000Z")

const rule = (id: string) =>
	new AlertRuleDocument({
		id: AlertRuleId.make(id),
		name: `Rule ${id}`,
		notes: null,
		notificationTemplate: null,
		enabled: true,
		severity: "warning",
		serviceNames: [`svc-${id}`],
		excludeServiceNames: [],
		environments: [],
		tags: [],
		groupBy: null,
		signalType: "error_rate",
		comparator: "gt",
		threshold: 0.05,
		thresholdUpper: null,
		windowMinutes: 15,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 1,
		consecutiveHealthyRequired: 1,
		renotifyIntervalMinutes: 60,
		apdexThresholdMs: null,
		queryBuilderDraft: null,
		rawQuerySql: null,
		rawQueryReducer: null,
		destinationIds: [],
		noDataBehavior: "skip",
		lastEvaluationError: null,
		lastEvaluatedAt: null,
		lastScheduledAt: null,
		createdAt: iso,
		updatedAt: iso,
		createdBy: UserId.make("user-1"),
		updatedBy: UserId.make("user-1"),
	})

const rulesResult = Result.success(new AlertRulesListResponse({ rules: [rule(RULE_A), rule(RULE_B)] }))

/**
 * Stands in for `AlertCreateFormSurface`, which seeds component-local state from
 * `initialForm` exactly like this and is far too heavy to mount here (it pulls
 * the whole dashboard chrome, router, and org collections). Only the draft
 * ownership matters for the keying contract.
 */
function DraftSurface({ initialName }: { initialName: string }) {
	const [name, setName] = useState(() => initialName)
	return (
		<button type="button" onClick={() => setName("edited in progress")}>
			{name}
		</button>
	)
}

/**
 * The page's keyed mount, reduced to the part under test: the surface is keyed
 * by `deriveRuleInitialization`'s key, so React's own remount semantics decide
 * whether the draft survives.
 */
function KeyedHost({ ruleId, tick }: { ruleId: string; tick: number }) {
	const init = deriveRuleInitialization({
		search: { ruleId },
		chartContext: undefined,
		rulesResult,
		dashboardsResult: Result.initial(),
	})
	if (init.status !== "ready") throw new Error(`expected ready, got ${init.status}`)
	return (
		<div data-tick={tick}>
			<DraftSurface key={init.draft.key} initialName={init.draft.form.name} />
		</div>
	)
}

describe("alert-create remount keying", () => {
	it("keeps in-progress edits across a re-render of the same rule", () => {
		const { rerender } = render(<KeyedHost ruleId={RULE_A} tick={0} />)
		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByRole("button").textContent).toBe("edited in progress")

		// Same rule, new render pass — the key is unchanged, so the draft stands.
		rerender(<KeyedHost ruleId={RULE_A} tick={1} />)
		expect(screen.getByRole("button").textContent).toBe("edited in progress")
	})

	it("remounts with the new rule's values when the rule changes", () => {
		const { rerender } = render(<KeyedHost ruleId={RULE_A} tick={0} />)
		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByRole("button").textContent).toBe("edited in progress")

		// Different rule → different key → fresh mount, so rule A's draft cannot
		// be carried over onto rule B.
		rerender(<KeyedHost ruleId={RULE_B} tick={1} />)
		expect(screen.getByRole("button").textContent).toBe(`Rule ${RULE_B}`)
	})
})
