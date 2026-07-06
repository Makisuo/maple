import { useNavigate } from "@tanstack/react-router"
import { Fragment } from "react"

import type { AlertDestinationDocument, AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import type { DerivedRuleStatus } from "@/lib/alerts/rule-status"
import type { TagGroup } from "@/lib/alerts/tag-grouping"

import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatusBadge, type AlertStatusState } from "@/components/alerts/alert-status-badge"
import { IncidentTimelineStrip } from "@/components/alerts/incident-timeline-strip"
import { NotifyChannels, SignalBadge, TagChips, TagGroupHeaderRow } from "@/components/alerts/overview/shared"
import { CircleWarningIcon } from "@/components/icons"
import { comparatorLabels, formatSignalValue } from "@/lib/alerts/form-utils"
import { worstState } from "@/lib/alerts/rule-status"
import { formatRelativeTime } from "@/lib/format"
import { Switch } from "@maple/ui/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"

const COL_SPAN = 8

/** Derived rule status → status-badge state ("healthy" renders as "OK"). */
const badgeState = (status: DerivedRuleStatus["status"]): AlertStatusState =>
	status === "healthy" ? "ok" : status

/**
 * The overview rules table: one row per rule with its live derived health,
 * a compact 24h incident strip, and the latest observed value vs threshold.
 */
export function RulesOverviewTable({
	rules,
	groups,
	grouped,
	destinationsById,
	derivedByRuleId,
	statesByRule,
	incidentsByRuleId,
	timelineRange,
	isAdmin,
	onToggle,
}: {
	/** Filtered rules, in list order. Ignored when {@link groups} is set. */
	rules: readonly AlertRuleDocument[]
	groups: TagGroup<AlertRuleDocument>[] | null
	grouped: boolean
	destinationsById: Map<string, AlertDestinationDocument>
	derivedByRuleId: Map<string, DerivedRuleStatus>
	statesByRule: Map<string, AlertRuleStateRow[]>
	/** All incidents per rule — the strip clips to {@link timelineRange}. */
	incidentsByRuleId: Map<string, AlertIncidentDocument[]>
	timelineRange: { min: number; max: number }
	isAdmin: boolean
	onToggle: (rule: AlertRuleDocument) => void
}) {
	const navigate = useNavigate()

	const renderRow = (rule: AlertRuleDocument, key: string) => {
		const derived = derivedByRuleId.get(rule.id)
		const state = worstState(statesByRule.get(rule.id) ?? [])
		// Dedupe by id: a rule that lists the same destination twice still
		// notifies it once, so show one mark (and keep React keys unique).
		const ruleDestinations = [...new Set(rule.destinationIds)]
			.map((id) => destinationsById.get(id))
			.filter((d): d is AlertDestinationDocument => d != null)

		const lastEvaluatedAt = state?.last_evaluated_at ?? rule.lastEvaluatedAt

		return (
			<TableRow
				key={key}
				className="cursor-pointer"
				onClick={() => navigate({ to: "/alerts/$ruleId", params: { ruleId: rule.id } })}
			>
				<TableCell onClick={(e) => e.stopPropagation()}>
					<Switch
						checked={rule.enabled}
						onCheckedChange={() => onToggle(rule)}
						disabled={!isAdmin}
					/>
				</TableCell>
				<TableCell className="min-w-0">
					<div className="flex items-center gap-2">
						<span className={cn("font-medium truncate", !rule.enabled && "text-muted-foreground")}>
							{rule.name}
						</span>
						<SignalBadge signalType={rule.signalType} />
					</div>
					{!grouped && <TagChips tags={rule.tags} />}
				</TableCell>
				<TableCell>
					<AlertSeverityBadge severity={rule.severity} />
				</TableCell>
				<TableCell>
					<div className="flex items-center gap-1.5">
						<AlertStatusBadge state={derived ? badgeState(derived.status) : "ok"} />
						{derived?.status === "error" && derived.reason != null && (
							<Tooltip>
								<TooltipTrigger
									render={<span className="inline-flex cursor-default" />}
									onClick={(e) => e.stopPropagation()}
								>
									<CircleWarningIcon size={14} className="text-destructive" />
								</TooltipTrigger>
								<TooltipContent className="max-w-[280px]">
									Last evaluation failed: {derived.reason}
								</TooltipContent>
							</Tooltip>
						)}
						{derived?.attention.noDestinations && (
							<Tooltip>
								<TooltipTrigger
									render={
										<span className="inline-flex cursor-default items-center gap-1 text-warning text-[11px]" />
									}
									onClick={(e) => e.stopPropagation()}
								>
									<CircleWarningIcon size={12} />
									No destinations
								</TooltipTrigger>
								<TooltipContent>
									Enabled but routed nowhere — this rule can notify no one.
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				</TableCell>
				<TableCell>
					<IncidentTimelineStrip
						incidents={incidentsByRuleId.get(rule.id) ?? []}
						range={timelineRange}
						buckets={30}
						compact
						showAxisLabels={false}
						className="min-w-[90px]"
					/>
				</TableCell>
				<TableCell>
					{state?.last_value != null ? (
						<span className="font-mono text-xs">
							{formatSignalValue(rule.signalType, state.last_value)}
							<span className="text-muted-foreground ml-1">
								{comparatorLabels[rule.comparator]}{" "}
								{formatSignalValue(rule.signalType, rule.threshold)}
							</span>
						</span>
					) : (
						<span className="text-muted-foreground text-xs">—</span>
					)}
				</TableCell>
				<TableCell className="text-muted-foreground text-xs tabular-nums">
					{lastEvaluatedAt ? formatRelativeTime(lastEvaluatedAt) : "—"}
				</TableCell>
				<TableCell onClick={(e) => e.stopPropagation()}>
					<NotifyChannels destinations={ruleDestinations} enabled={rule.enabled} />
				</TableCell>
			</TableRow>
		)
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-[40px]" />
					<TableHead className="min-w-[220px]">Name</TableHead>
					<TableHead className="w-[100px]">Severity</TableHead>
					<TableHead className="w-[140px]">Status</TableHead>
					<TableHead className="w-[120px]">Last 24h</TableHead>
					<TableHead className="w-[160px]">Last value</TableHead>
					<TableHead className="w-[110px]">Evaluated</TableHead>
					<TableHead className="w-[110px]">Notify</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{groups
					? groups.map((group) => (
							<Fragment key={group.key}>
								<TagGroupHeaderRow
									label={group.label}
									count={group.count}
									noun="rule"
									colSpan={COL_SPAN}
								/>
								{group.items.map((rule) => renderRow(rule, `${group.key}:${rule.id}`))}
							</Fragment>
						))
					: rules.map((rule) => renderRow(rule, rule.id))}
			</TableBody>
		</Table>
	)
}
