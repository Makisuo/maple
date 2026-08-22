import { useMemo } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/lib/utils"

import type { AlertRulePreviewResponse } from "@maple/domain/http"
import { AlertRuleChart } from "@/components/alerts/alert-rule-chart"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { CheckIcon, EyeIcon, FireIcon, LoaderIcon } from "@/components/icons"
import { breachStatsFromPreview, formatBreachDuration, type BreachStats } from "@/lib/alerts/breach-stats"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import type { TimeRange } from "@/components/time-range-picker/types"
import {
	formThresholdToDomain,
	formatSignalValue,
	signalLabels,
	type RuleFormState,
} from "@/lib/alerts/form-utils"

interface RuleLiveChartHeroProps {
	form: RuleFormState
	/** Evaluator-faithful preview from `useAlertRulePreview`. */
	preview: AlertRulePreviewResponse | null
	previewLoading: boolean
	previewError: string | null
	onTestRule: () => void
	testing: boolean
	previewResult: {
		status: "breached" | "healthy" | "skipped"
		value: number | null
	} | null
	/** Resolved absolute window the preview was evaluated over. */
	range: { startTime: string; endTime: string }
	/** The picker's own (unresolved) selection — preset or custom bounds. */
	timeRange: TimeRange
	onTimeRangeChange: (range: TimeRange) => void
}

/**
 * Hero block sitting above the form: the SAME chart the rule detail page
 * renders, fed by the evaluator's own preview over a user-picked lookback —
 * threshold line, per-window observations, and shaded "would have fired"
 * spans. The would-have-fired count is folded into the header strip as a
 * compact pill so the entire hero stays inside one short card. Raw-SQL rules
 * get a real preview too (the endpoint replays the SQL per evaluation window).
 */
export function RuleLiveChartHero({
	form,
	preview,
	previewLoading,
	previewError,
	onTestRule,
	testing,
	previewResult,
	range,
	timeRange,
	onTimeRangeChange,
}: RuleLiveChartHeroProps) {
	// The preview plots observed signal data in domain units (error_rate as a
	// 0–1 ratio), so the threshold line must be converted from the form's percent
	// input to the same domain units to line up with the data.
	const threshold = formThresholdToDomain(form.signalType, form.threshold)
	const thresholdUpper =
		form.thresholdUpper.trim().length > 0 && Number.isFinite(Number(form.thresholdUpper))
			? formThresholdToDomain(form.signalType, form.thresholdUpper)
			: null

	// The chart's domain is the exact window the preview query ran over, so the
	// axis, threshold line, and would-fire bands stay in step with the picker.
	const window = useMemo(
		() => ({
			min: new Date(normalizeTimestampInput(range.startTime)).getTime(),
			max: new Date(normalizeTimestampInput(range.endTime)).getTime(),
		}),
		[range.startTime, range.endTime],
	)

	const stats = useMemo(() => breachStatsFromPreview(preview), [preview])

	const safeThreshold = Number.isFinite(threshold) ? threshold : 0
	const groupBySummary = formatGroupBySummary(form)

	return (
		<Card className="overflow-hidden">
			<div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
				<div className="flex min-w-0 items-center gap-2">
					<Badge variant="outline" className="font-mono text-xs">
						{signalLabels[form.signalType]}
					</Badge>
					{groupBySummary && (
						<span className="hidden max-w-[360px] truncate text-muted-foreground text-xs md:inline">
							Grouped by {groupBySummary}
						</span>
					)}
					<BreachPill stats={stats} />
				</div>
				{/* shrink-0: a custom range's long label must squeeze the left-hand
				    summary, not the controls. */}
				<div className="flex shrink-0 items-center gap-2">
					{previewResult && (
						<PreviewBadge
							status={previewResult.status}
							value={previewResult.value}
							signalType={form.signalType}
						/>
					)}
					{/* Preview-only lookback: it re-runs the preview query, never the
					    rule being saved. */}
					<TimeRangePicker
						startTime={timeRange.startTime}
						endTime={timeRange.endTime}
						presetValue={timeRange.presetValue}
						onChange={onTimeRangeChange}
					/>
					<Button variant="outline" size="sm" onClick={onTestRule} disabled={testing}>
						{testing ? <LoaderIcon size={14} className="animate-spin" /> : <EyeIcon size={14} />}
						Test rule
					</Button>
				</div>
			</div>

			<div className="px-4 pb-4">
				<AlertRuleChart
					preview={preview}
					showWouldFire
					threshold={safeThreshold}
					thresholdUpper={thresholdUpper}
					comparator={form.comparator}
					signalType={form.signalType}
					window={window}
					loading={previewLoading}
					error={previewError}
				/>
			</div>
		</Card>
	)
}

function formatGroupBySummary(form: RuleFormState): string | null {
	const groupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns?.groupBy
			? (form.queryBuilderDraft.groupBy ?? [])
			: form.groupBy
	const visible = groupBy.filter((value) => value !== "none")
	if (visible.length === 0) return null
	return visible.join(", ")
}

function BreachPill({ stats }: { stats: BreachStats }) {
	if (stats.bucketCount === 0) return null
	if (stats.breachCount === 0) {
		return (
			<span className="hidden items-center gap-1 text-xs text-success-foreground sm:inline-flex">
				<CheckIcon size={12} />
				No breaches in this window
			</span>
		)
	}
	return (
		<span className="hidden items-center gap-1 text-xs text-destructive sm:inline-flex">
			<FireIcon size={12} />
			Would have fired{" "}
			<span className="font-mono font-semibold tabular-nums">{stats.breachCount}×</span>
			{stats.longestRunMs !== null && (
				<>
					{" "}
					· longest{" "}
					<span className="font-mono font-semibold tabular-nums">
						{formatBreachDuration(stats.longestRunMs)}
					</span>
				</>
			)}
		</span>
	)
}

function PreviewBadge({
	status,
	value,
	signalType,
}: {
	status: "breached" | "healthy" | "skipped"
	value: number | null
	signalType: RuleFormState["signalType"]
}) {
	if (status === "skipped") {
		return <span className="text-muted-foreground text-xs">Skipped · insufficient samples</span>
	}
	return (
		<div className="flex items-center gap-2">
			<span
				className={cn(
					"font-mono text-sm font-semibold tabular-nums",
					status === "breached" ? "text-destructive" : "text-success",
				)}
			>
				{formatSignalValue(signalType, value)}
			</span>
			<AlertStatusBadge
				state={status === "breached" ? "firing" : "ok"}
				label={status === "breached" ? "Would trigger" : "Within threshold"}
			/>
		</div>
	)
}
