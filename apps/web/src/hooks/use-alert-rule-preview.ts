import { useDeferredValue, useMemo } from "react"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	AlertRulePreviewRequest,
	IsoDateTimeString,
	isRangeComparator,
	type AlertRulePreviewResponse,
} from "@maple/domain/http"
import { buildRuleRequest, deriveRuleQueryIssues, type RuleFormState } from "@/lib/alerts/form-utils"
import { mapBuilderChartFailure } from "@/lib/alerts/preview-failure"
import { formatBackendError } from "@/lib/error-messages"
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
	if (form.signalType === "metric" && form.metricName.trim().length === 0) return false
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
	form: RuleFormState,
	range?: { startTime: string; endTime: string },
): AlertRulePreviewState {
	// Callers that own a page-level time window (the rule detail page) pass it in;
	// the create form + live hero pass nothing and keep the canned last-24h window.
	const fallback = useEffectiveTimeRange(undefined, undefined, "24h")
	const startTime = range?.startTime ?? fallback.startTime
	const endTime = range?.endTime ?? fallback.endTime

	// Defer per-keystroke form edits so preview requests trail the typing.
	const deferredForm = useDeferredValue(form)

	const payload = useMemo(() => {
		if (!isPreviewQueryReady(deferredForm)) return null
		try {
			// The upsert schema requires a non-empty name; the preview doesn't care,
			// so substitute a placeholder while the user hasn't typed one yet.
			const rule = buildRuleRequest(
				deferredForm.name.trim().length > 0
					? deferredForm
					: { ...deferredForm, name: "Untitled rule" },
			)
			return new AlertRulePreviewRequest({
				rule,
				startTime: IsoDateTimeString.make(
					new Date(normalizeTimestampInput(startTime)).toISOString(),
				),
				endTime: IsoDateTimeString.make(new Date(normalizeTimestampInput(endTime)).toISOString()),
			})
		} catch {
			// A mid-edit form state the request schema rejects — no request.
			return null
		}
	}, [deferredForm, startTime, endTime])

	const result = useAtomValue(
		payload
			? MapleApiAtomClient.query("alerts", "previewRule", {
					payload,
					reactivityKeys: ["alertPreview"],
					// Idle TTL so abandoned keystroke variants don't accumulate.
					timeToLive: 30_000,
				})
			: emptyPreviewAtom,
	)

	return useMemo(() => {
		if (!payload) {
			// Unpreviewable state: surface the compile issue inline when there is one.
			const issues = deriveRuleQueryIssues(deferredForm)
			return { preview: null, previewLoading: false, previewError: issues[0] ?? null }
		}
		return Result.builder(result)
			.onSuccess(
				(response): AlertRulePreviewState => ({
					preview: response as AlertRulePreviewResponse,
					previewLoading: false,
					previewError: null,
				}),
			)
			.onError(
				(error): AlertRulePreviewState => ({
					preview: null,
					previewLoading: false,
					previewError: mapBuilderChartFailure(formatBackendError(error).description),
				}),
			)
			.orElse(
				(): AlertRulePreviewState => ({ preview: null, previewLoading: true, previewError: null }),
			)
	}, [payload, result, deferredForm])
}
