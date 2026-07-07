import { Link, useNavigate } from "@tanstack/react-router"
import { Fragment, useMemo } from "react"

import type { AlertIncidentDocument } from "@maple/domain/http"

import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { sortIncidents, TagChips, TagGroupHeaderRow } from "@/components/alerts/overview/shared"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import { groupByTag as groupItemsByTag } from "@/lib/alerts/tag-grouping"
import { formatRelativeTime } from "@/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"

/**
 * Open incidents, severity-sorted, with tag inheritance from the owning rule.
 * Shown at the top of the overview whenever anything is firing.
 */
export function ActiveIncidentsTable({
	incidents,
	tagsByRuleId,
	grouped,
}: {
	/** Open incidents, already tag-filtered by the overview toolbar. */
	incidents: readonly AlertIncidentDocument[]
	tagsByRuleId: Map<string, readonly string[]>
	grouped: boolean
}) {
	const navigate = useNavigate()

	const sorted = useMemo(() => sortIncidents(incidents), [incidents])
	const groups = useMemo(
		() => (grouped ? groupItemsByTag(sorted, (i) => tagsByRuleId.get(i.ruleId) ?? []) : null),
		[grouped, sorted, tagsByRuleId],
	)

	const renderRow = (incident: AlertIncidentDocument, key: string) => {
		const duration = incident.lastTriggeredAt ? formatRelativeTime(incident.lastTriggeredAt) : "—"
		const tags = tagsByRuleId.get(incident.ruleId) ?? []
		return (
			<TableRow
				key={key}
				className="cursor-pointer"
				onClick={() => navigate({ to: "/alerts/$ruleId", params: { ruleId: incident.ruleId } })}
			>
				<TableCell>
					<AlertSeverityBadge severity={incident.severity} />
				</TableCell>
				<TableCell>
					<Link
						to="/alerts/$ruleId"
						params={{ ruleId: incident.ruleId }}
						className="font-medium hover:underline"
					>
						{incident.ruleName}
					</Link>
					{!grouped && <TagChips tags={tags} />}
				</TableCell>
				<TableCell>
					<span className="font-mono text-muted-foreground">{incident.groupKey ?? "all"}</span>
				</TableCell>
				<TableCell>
					<span className="font-mono text-destructive">
						{formatSignalValue(incident.signalType, incident.lastObservedValue)}
					</span>
					<span className="text-muted-foreground text-xs ml-1">
						/ {formatSignalValue(incident.signalType, incident.threshold)}
					</span>
				</TableCell>
				<TableCell>{duration}</TableCell>
				<TableCell>
					{incident.lastNotifiedAt ? formatRelativeTime(incident.lastNotifiedAt) : "Never"}
				</TableCell>
			</TableRow>
		)
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<h2 className="text-lg font-semibold">Active incidents</h2>
				<Badge variant="secondary" className="rounded-full tabular-nums">
					{sorted.length}
				</Badge>
			</div>

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[90px]">Severity</TableHead>
						<TableHead>Rule</TableHead>
						<TableHead>Group</TableHead>
						<TableHead>Current value</TableHead>
						<TableHead className="w-[110px]">Duration</TableHead>
						<TableHead>Last notified</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sorted.length === 0 ? (
						<TableRow>
							<TableCell colSpan={6} className="py-8 text-center text-muted-foreground text-sm">
								No active incidents match the selected tags.
							</TableCell>
						</TableRow>
					) : groups ? (
						groups.map((group) => (
							<Fragment key={group.key}>
								<TagGroupHeaderRow
									label={group.label}
									count={group.count}
									noun="incident"
									colSpan={6}
								/>
								{group.items.map((incident) => renderRow(incident, `${group.key}:${incident.id}`))}
							</Fragment>
						))
					) : (
						sorted.map((incident) => renderRow(incident, incident.id))
					)}
				</TableBody>
			</Table>
		</div>
	)
}
