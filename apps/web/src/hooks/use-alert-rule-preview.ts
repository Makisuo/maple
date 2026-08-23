import { useDeferredValue, useMemo } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { IsoDateTimeString, isRangeComparator, type AlertRulePreviewResponse } from "@maple/domain/http"
import type { V2AlertRulePreviewParams } from "@maple/domain/http/v2"
import {
	buildRuleCreateParamsV2,
	deriveRuleQueryIssues,
	v2PreviewToResponse,
	type RuleFormState,
} from "@/lib/alerts/form-utils"
import { mapBuilderChartFailure } from "@/lib/alerts/preview-failure"
import { displayError } from "@/lib/error-messages"
import { normalizeTimestampInput } from "@/lib/timezone-format"

const emptyPreviewAtom = Atom.make(Result.initial())

export interface AlertRulePreviewState {
	/** Evaluator-faithful preview: per-window observations + would-fire spans. */
	preview: AlertRulePreviewResponse | null
	previewLoading: boolean
	/** Human-readable failure (compile issue or backend error); null when healthy. */
	previewError: string | null
}

/**
 * Whether the form describes a query the preview endpoint can evaluate. Unlike
 * `isRulePreviewReady` this deliberately ignores name/destinations — the chart
 * should light up as soon as the signal itself is coherent.
 */
const isPreviewQueryReady = (form: RuleFormState): boolean => {
	if (!Number.isFinite(Number(form.threshold))) return false
	if (isRangeComparator(form.comparator) && !Number.isFinite(Number(form.thresholdUpper))) {
		return false
	}
	if (form.signalType === "raw_query") {
		const sql = form.rawQuerySql.trim()
		if (sql.length === 0 || !sql.includes("$__orgFilter")) return false
	}
	return deriveRuleQueryIssues(form).length === 0
}

/**
 * Evaluator-faithful preview data for the shared alert rule chart
 * ({@link import("@/components/alerts/alert-rule-chart").AlertRuleChart}).
 *
 * All signal types — built-in, builder_query, AND raw_query — go through the
 * same `previewRule` endpoint the scheduler's evaluation path backs, so the
 * chart shown while creating a rule is exactly the chart shown while tracking
 * it: same bucketing (one bucket per evaluation window), same filters
 * (rootSpansOnly, exclude-services), same no-data semantics.
 */
export function useAlertRulePreview(
	form: RuleFormState | null,
	range?: { startTime: string; endTime: string },
): AlertRulePreviewState {
	// Callers own their window: the rule detail page passes its page-level range,
	// the create/edit form passes the lookback picked next to the preview chart.
	// Only callers with no window at all fall back to the canned last 24h.
	const fallback = useEffectiveTimeRange(undefined, undefined, "24h")
	const startTime = range?.startTime ?? fallback.startTime
	const endTime = range?.endTime ?? fallback.endTime

	// Defer per-keystroke form edits so preview requests trail the typing.
	const deferredForm = useDeferredValue(form)

	const payload = useMemo((): V2AlertRulePreviewParams | null => {
		if (deferredForm === null || !isPreviewQueryReady(deferredForm)) return null
		// The rule params require a non-empty name; the preview doesn't care,
		// so substitute a placeholder while the user hasn't typed one yet.
		const rule = buildRuleCreateParamsV2(
			deferredForm.name.trim().length > 0 ? deferredForm : { ...deferredForm, name: "Untitled rule" },
		)
		return {
			rule,
			start_time: IsoDateTimeString.make(new Date(normalizeTimestampInput(startTime)).toISOString()),
			end_time: IsoDateTimeString.make(new Date(normalizeTimestampInput(endTime)).toISOString()),
		}
	}, [deferredForm, startTime, endTime])

	const result = useAtomValue(
		payload
			? retainedQueryV2("alertRules", "preview", {
					payload,
					reactivityKeys: ["alertPreview"],
					// Idle TTL so abandoned keystroke variants don't accumulate.
					timeToLive: 30_000,
				})
			: emptyPreviewAtom,
	)

	return useMemo(() => {
		if (!payload) {
			// No form yet (rule still resolving) is not an authoring error — stay clean.
			// A present-but-unpreviewable form surfaces its compile issue inline.
			const issues = deferredForm === null ? [] : deriveRuleQueryIssues(deferredForm)
			return { preview: null, previewLoading: false, previewError: issues[0] ?? null }
		}
		return Result.builder(result)
			.onSuccess(
				(response): AlertRulePreviewState => ({
					preview: v2PreviewToResponse(response),
					previewLoading: false,
					previewError: null,
				}),
			)
			.onError(
				(error): AlertRulePreviewState => ({
					preview: null,
					previewLoading: false,
					previewError: mapBuilderChartFailure(displayError(error).message),
				}),
			)
			.orElse(
				(): AlertRulePreviewState => ({ preview: null, previewLoading: true, previewError: null }),
			)
	}, [payload, result, deferredForm])
}
