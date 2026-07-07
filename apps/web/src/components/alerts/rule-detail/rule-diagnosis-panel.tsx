import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"

import type {
	AlertCheckDocument,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/utils"
import { CheckIcon, ChevronDownIcon, CircleWarningIcon } from "@/components/icons"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import {
	buildDiagnosis,
	diagnosisVerdict,
	type DiagnosisStage,
	type DiagnosisStageStatus,
} from "@/lib/alerts/diagnosis"
import { worstState } from "@/lib/alerts/rule-status"
import { AlertSegmentedSelect } from "@/components/alerts/alert-segmented-select"

const STATUS_ICON: Record<DiagnosisStageStatus, { className: string }> = {
	pass: { className: "text-success" },
	warn: { className: "text-warning" },
	fail: { className: "text-destructive" },
	unknown: { className: "text-muted-foreground" },
}

/**
 * "Why isn't this firing? / Why is this failing?" — walks the evaluation
 * pipeline stage by stage with the evidence for each verdict. Collapsed to a
 * one-line verdict when everything passes; auto-expanded when any stage
 * fails or warns.
 */
export function RuleDiagnosisPanel({
	rule,
	states,
	checks,
	openIncidents,
	destinations,
	deliveryEvents,
	now,
	onToggleEnabled,
}: {
	rule: AlertRuleDocument
	states: ReadonlyArray<AlertRuleStateRow>
	checks: ReadonlyArray<AlertCheckDocument>
	openIncidents: ReadonlyArray<AlertIncidentDocument>
	destinations: ReadonlyArray<AlertDestinationDocument>
	deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	now: number
	onToggleEnabled?: () => void
}) {
	// Grouped rules: diagnose one group at a time, defaulting to the worst one.
	const groupKeys = useMemo(() => {
		const keys = [...new Set(states.map((s) => s.group_key))].sort()
		return keys.length > 1 ? keys : []
	}, [states])
	const defaultGroupKey = useMemo(() => worstState(states)?.group_key ?? null, [states])
	const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
	const activeGroup = selectedGroup ?? defaultGroupKey

	const stages = useMemo(
		() =>
			buildDiagnosis({
				rule,
				states,
				checks,
				openIncidents,
				destinations,
				deliveryEvents,
				now,
				...(groupKeys.length > 0 && activeGroup != null ? { selectedGroupKey: activeGroup } : {}),
			}),
		[rule, states, checks, openIncidents, destinations, deliveryEvents, now, groupKeys, activeGroup],
	)
	const verdict = useMemo(() => diagnosisVerdict(stages), [stages])
	const hasProblems = verdict.status !== "pass"
	const [expanded, setExpanded] = useState<boolean | null>(null)
	const isOpen = expanded ?? hasProblems

	return (
		<Card className="overflow-hidden">
			<button
				type="button"
				className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
				onClick={() => setExpanded(!isOpen)}
			>
				<div className="flex min-w-0 items-center gap-2.5">
					<StageIcon status={verdict.status} size={16} />
					<div className="min-w-0">
						<p className="text-sm font-medium">
							{verdict.status === "pass" ? "Rule is healthy" : "Why is this alert failing?"}
						</p>
						<p className="truncate text-xs text-muted-foreground">{verdict.summary}</p>
					</div>
				</div>
				<ChevronDownIcon
					size={16}
					className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")}
				/>
			</button>

			{isOpen && (
				<div className="border-t px-4 py-3">
					{groupKeys.length > 0 && (
						<div className="mb-3 flex items-center gap-2">
							<span className="text-xs text-muted-foreground">Group</span>
							<AlertSegmentedSelect
								value={activeGroup ?? groupKeys[0]!}
								onChange={(value) => setSelectedGroup(value)}
								options={groupKeys.slice(0, 8).map((key) => ({ value: key, label: key }))}
							/>
						</div>
					)}
					<ol className="space-y-1.5">
						{stages.map((stage) => (
							<DiagnosisStageRow key={stage.id} stage={stage} onToggleEnabled={onToggleEnabled} />
						))}
					</ol>
				</div>
			)}
		</Card>
	)
}

function DiagnosisStageRow({
	stage,
	onToggleEnabled,
}: {
	stage: DiagnosisStage
	onToggleEnabled?: () => void
}) {
	const problematic = stage.status === "fail" || stage.status === "warn"
	const [open, setOpen] = useState<boolean | null>(null)
	const showEvidence = (open ?? problematic) && stage.evidence.length > 0

	return (
		<li
			className={cn(
				"rounded-md px-2 py-1.5",
				stage.status === "fail" && "bg-destructive/5",
				stage.status === "warn" && "bg-warning/5",
			)}
		>
			<div className="flex items-center gap-2.5">
				<StageIcon status={stage.status} size={14} />
				<button
					type="button"
					className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
					onClick={() => setOpen(!(open ?? problematic))}
				>
					<span className="shrink-0 text-xs font-medium">{stage.label}</span>
					<span
						className={cn(
							"truncate text-xs",
							stage.status === "fail" ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{stage.summary}
					</span>
				</button>
				{stage.action != null && (
					<DiagnosisAction action={stage.action} onToggleEnabled={onToggleEnabled} />
				)}
			</div>
			{showEvidence && (
				<ul className="mt-1 space-y-0.5 pl-[26px]">
					{stage.evidence.map((line) => (
						<li key={line} className="break-words text-xs text-muted-foreground">
							{line}
						</li>
					))}
				</ul>
			)}
		</li>
	)
}

function DiagnosisAction({
	action,
	onToggleEnabled,
}: {
	action: NonNullable<DiagnosisStage["action"]>
	onToggleEnabled?: () => void
}) {
	if (action.kind === "enable") {
		if (onToggleEnabled == null) return null
		return (
			<Button variant="outline" size="xs" onClick={onToggleEnabled}>
				{action.label}
			</Button>
		)
	}
	if (action.kind === "destinations") {
		return (
			<Button variant="outline" size="xs" render={<Link to="/alerts" search={{ tab: "settings" }} />}>
				{action.label}
			</Button>
		)
	}
	return null
}

function StageIcon({ status, size }: { status: DiagnosisStageStatus; size: number }) {
	const tone = STATUS_ICON[status]
	if (status === "pass") return <CheckIcon size={size} className={cn("shrink-0", tone.className)} />
	return <CircleWarningIcon size={size} className={cn("shrink-0", tone.className)} />
}
