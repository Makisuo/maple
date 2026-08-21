import {
	AlertRuleDocument,
	AlertRuleId,
	AlertRulesListResponse,
	IsoDateTimeString,
	UserId,
} from "@maple/domain/http"
import { describe, expect, it } from "vitest"

import { Result } from "@/lib/effect-atom"
import { deriveRuleInitialization, type RuleDraft } from "./alert-create-page-content"

/**
 * The starter-template deep link from the overview empty state. With no ruleId /
 * chart / dashboard params, `deriveRuleInitialization` reaches the template
 * branch before the rules/dashboards results ever matter, so `Result.initial()`
 * stands in for both.
 */
const loading = Result.initial()

/** Narrows to the ready variant, failing the test if the draft is absent. */
function readyDraft(init: ReturnType<typeof deriveRuleInitialization>): RuleDraft {
	expect(init.status).toBe("ready")
	if (init.status !== "ready") throw new Error("unreachable")
	return init.draft
}

const iso = IsoDateTimeString.make("2026-08-16T00:00:00.000Z")

/** `AlertRuleId` is a UUID brand, so the fixtures must carry real UUIDs. */
const RULE_A = "11111111-1111-4111-8111-111111111111"
const RULE_B = "22222222-2222-4222-8222-222222222222"
const RULE_GONE = "33333333-3333-4333-8333-333333333333"

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

/** A resolved rules list — the shape `useAlertRulesList` reports on success. */
const rulesLoaded = (...ids: string[]) => Result.success(new AlertRulesListResponse({ rules: ids.map(rule) }))

/** The terminal failure `useAlertRulesList` reports when the shape stream dies. */
const rulesFailed = () => Result.fail({ message: "Live sync is unavailable." })

const editSearch = (ruleId: string) => ({ ruleId })

describe("deriveRuleInitialization — editing an existing rule", () => {
	it("is ready with the rule's own form state when the rule resolves", () => {
		const draft = readyDraft(
			deriveRuleInitialization({
				search: editSearch(RULE_A),
				chartContext: undefined,
				rulesResult: rulesLoaded(RULE_A, RULE_B),
				dashboardsResult: loading,
			}),
		)

		expect(draft.editingRule?.id).toBe(RULE_A)
		expect(draft.form.name).toBe(`Rule ${RULE_A}`)
		expect(draft.form.serviceNames).toEqual([`svc-${RULE_A}`])
		expect(draft.prefillNotices).toEqual([])
		expect(draft.key).toBe(`rule:${RULE_A}`)
	})

	it("is loading — not failed — while the rules list is still resolving", () => {
		const init = deriveRuleInitialization({
			search: editSearch(RULE_A),
			chartContext: undefined,
			rulesResult: loading,
			dashboardsResult: loading,
		})

		expect(init).toEqual({ status: "loading", editing: true })
		// The draft is absent by construction: no blank form can leak into the
		// pending state and read as "Create alert rule".
		expect("draft" in init).toBe(false)
	})

	it("is ready with a blank draft and a notice when the list resolves without the rule", () => {
		const draft = readyDraft(
			deriveRuleInitialization({
				search: editSearch(RULE_GONE),
				chartContext: undefined,
				rulesResult: rulesLoaded(RULE_A),
				dashboardsResult: loading,
			}),
		)

		expect(draft.editingRule).toBeNull()
		expect(draft.form.name).toBe("")
		expect(draft.prefillNotices).toEqual([
			{
				severity: "warning",
				message: "The alert rule could not be found. Starting from a blank alert.",
			},
		])
		expect(draft.key).toBe(`missing-rule:${RULE_GONE}`)
	})

	// The regression this union exists for: a terminal list failure is neither
	// success nor pending, and used to fall through to the loading branch — the
	// page painted a skeleton that never resolved, indistinguishable from a slow
	// load and with no way out but a manual reload.
	it("is failed — not loading — when the rules list terminally fails", () => {
		const init = deriveRuleInitialization({
			search: editSearch(RULE_A),
			chartContext: undefined,
			rulesResult: rulesFailed(),
			dashboardsResult: loading,
		})

		expect(init.status).toBe("failed")
		if (init.status !== "failed") throw new Error("unreachable")
		expect(init.editing).toBe(true)
		expect(init.error).toEqual({ message: "Live sync is unavailable." })
	})
})

describe("deriveRuleInitialization — remount keys", () => {
	const initFor = (ruleId: string) =>
		deriveRuleInitialization({
			search: editSearch(ruleId),
			chartContext: undefined,
			rulesResult: rulesLoaded(RULE_A, RULE_B),
			dashboardsResult: loading,
		})

	it("derives a stable key for repeated derivations of the same rule", () => {
		// A re-render must not change the key, or the surface remounts and the
		// user's in-progress edits are discarded mid-typing.
		expect(readyDraft(initFor(RULE_A)).key).toBe(readyDraft(initFor(RULE_A)).key)
	})

	it("derives a different key per rule so switching rules remounts the surface", () => {
		expect(readyDraft(initFor(RULE_A)).key).not.toBe(readyDraft(initFor(RULE_B)).key)
	})

	it("does not reuse a resolved rule's key for the missing-rule fallback", () => {
		const resolved = readyDraft(initFor(RULE_A)).key
		const missing = readyDraft(
			deriveRuleInitialization({
				search: editSearch(RULE_A),
				chartContext: undefined,
				rulesResult: rulesLoaded(),
				dashboardsResult: loading,
			}),
		).key

		expect(missing).not.toBe(resolved)
	})
})

describe("deriveRuleInitialization — template deep link", () => {
	// `low_apdex` differs from the blank defaults on signal, comparator, and
	// threshold, so a pass proves the template was applied (not just defaults).
	it("pre-applies a known template and skips the first-touch overlay", () => {
		const draft = readyDraft(
			deriveRuleInitialization({
				search: { template: "low_apdex" },
				chartContext: undefined,
				rulesResult: loading,
				dashboardsResult: loading,
			}),
		)

		expect(draft.form.signalType).toBe("apdex")
		expect(draft.form.comparator).toBe("lt")
		expect(draft.form.threshold).toBe("0.8")
		expect(draft.form.apdexThresholdMs).toBe("500")
		expect(draft.form.name).toBe("Low Apdex score")
		expect(draft.showTemplatesInitially).toBe(false)
		expect(draft.key).toBe("new:template:low_apdex")
	})

	it("falls through to a blank draft (overlay opens) for an unknown template id", () => {
		const draft = readyDraft(
			deriveRuleInitialization({
				search: { template: "not-a-real-template" },
				chartContext: undefined,
				rulesResult: loading,
				dashboardsResult: loading,
			}),
		)

		expect(draft.form.signalType).toBe("error_rate")
		expect(draft.form.name).toBe("")
		// No serviceName + unknown template → the overlay still leads the flow.
		expect(draft.showTemplatesInitially).toBe(true)
		expect(draft.key).toBe("new:blank")
	})
})
