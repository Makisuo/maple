import type {
	AiTriageIncidentKind,
	AnomalyIncidentDocument,
	ErrorIssueDocument,
	ErrorIssueId,
	WorkflowState,
} from "@maple/domain/http"

import type { AlertContext } from "@/components/chat/alert-context"
import {
	alertContextToInvestigation,
	type InvestigationContext,
	type InvestigationKind,
} from "@/components/chat/investigation-context"
import { narrowAlertSignal } from "@/components/ai-triage/breach"
import {
	deviation,
	formatSignalValue as formatAnomalyValue,
	isStaleOpenIncident,
	RESOLVE_REASON_LABEL,
	severityToneFor,
	SIGNAL_LABEL as ANOMALY_SIGNAL_LABEL,
} from "@/components/anomalies/anomaly-format"
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/components/errors/severity-badge"
import { comparatorLabels, signalLabels } from "@/lib/alerts/form-utils"
import { formatRelativeTime } from "@/lib/format"

/** A coloured pill (severity / status) — `tone` is the Tailwind class set for a Badge. */
export interface TokenBadge {
	label: string
	tone: string
}

/** One labelled fact row in the scorecard rail. */
export interface ScorecardRow {
	label: string
	value: string
	title?: string
	mono?: boolean
}

export interface ScorecardGroup {
	label: string
	rows: ScorecardRow[]
}

/** The headline stat in the Assessment block (breach / deviation / occurrences). */
export interface HeadlineStat {
	label: string
	primary: string
	secondary?: string
	/** True when the value sits on the bad side (tints it destructive). */
	bad?: boolean
}

export interface EntityLink {
	label: string
	/** Resolved path string, e.g. `/alerts/<ruleId>` (rendered via TanStack Link). */
	href: string
}

/**
 * The kind-agnostic descriptor every investigation surface renders from. Built by
 * one of the per-kind adapters below; the AI scorecard (severity/confidence) comes
 * from the triage run, while `headline`/`groups` carry the subject's own facts.
 */
export interface InvestigationSubject {
	kind: InvestigationKind
	id: string
	/** Drives `useAiTriageRun`. */
	triage: { incidentKind: AiTriageIncidentKind; incidentId: string | null; issueId?: ErrorIssueId }
	title: string
	subtitle?: string
	severity?: TokenBadge
	status: TokenBadge
	headline?: HeadlineStat
	groups: ScorecardGroup[]
	entityLinks: EntityLink[]
	chat: InvestigationContext
}

/* -------------------------------------------------------------------------- */
/*  Alert                                                                      */
/* -------------------------------------------------------------------------- */

const ALERT_SEVERITY_TONE: Record<string, string> = {
	critical: "bg-destructive/10 text-destructive",
	warning: "bg-severity-warn/10 text-severity-warn",
}

export function subjectFromAlertContext(
	alert: AlertContext,
	opts?: { issueId?: ErrorIssueId },
): InvestigationSubject {
	const { signalType, comparator, breach } = narrowAlertSignal(alert)
	const firing = alert.eventType !== "resolve"

	const signalRows: ScorecardRow[] = [
		{ label: "Metric", value: signalType ? signalLabels[signalType] : alert.signalType },
		{
			label: "Condition",
			value: `${comparator ? comparatorLabels[comparator] : alert.comparator} ${breach?.threshold ?? alert.threshold}`,
			mono: true,
		},
		{ label: "Window", value: `${alert.windowMinutes}min` },
	]
	if (alert.groupKey)
		signalRows.push({ label: "Group", value: alert.groupKey, mono: true, title: alert.groupKey })
	if (alert.sampleCount !== null)
		signalRows.push({ label: "Samples", value: alert.sampleCount.toLocaleString() })

	return {
		kind: "alert",
		id: alert.incidentId ?? alert.ruleId,
		triage: {
			incidentKind: "alert",
			incidentId: alert.incidentId,
			...(opts?.issueId ? { issueId: opts.issueId } : {}),
		},
		title: alert.ruleName,
		severity: {
			label: alert.severity,
			tone: ALERT_SEVERITY_TONE[alert.severity] ?? "bg-muted text-muted-foreground",
		},
		status: firing
			? { label: "Firing", tone: "bg-destructive/10 text-destructive" }
			: { label: "Resolved", tone: "bg-muted text-muted-foreground" },
		headline: breach
			? {
					label: "Breach",
					primary: `${breach.observed} vs ${breach.threshold}`,
					secondary: breach.delta ?? undefined,
					bad: breach.exceedsThreshold,
				}
			: undefined,
		groups: [{ label: "Signal", rows: signalRows }],
		entityLinks: [{ label: "View alert rule", href: `/alerts/${alert.ruleId}` }],
		chat: alertContextToInvestigation(alert),
	}
}

/* -------------------------------------------------------------------------- */
/*  Anomaly                                                                    */
/* -------------------------------------------------------------------------- */

/** Map an anomaly signal onto the alert-style signal key the chat hints/suggestions use. */
const ANOMALY_SIGNAL_TO_CHAT: Record<string, string> = {
	error_rate: "error_rate",
	latency_p95: "p95_latency",
	throughput: "throughput",
	error_spike: "metric",
	log_volume: "metric",
}

export function subjectFromAnomaly(incident: AnomalyIncidentDocument): InvestigationSubject {
	const open = incident.status === "open"
	const stale = isStaleOpenIncident(incident)
	const tone = severityToneFor(incident)
	const dev = deviation(incident)
	const fmt = (v: number) => formatAnomalyValue(incident.signalType, v)
	const metric = ANOMALY_SIGNAL_LABEL[incident.signalType]

	const facts = [
		{ key: "observed", label: "Observed", value: fmt(incident.lastObservedValue) },
		{ key: "baseline", label: "Baseline", value: fmt(incident.baselineMedian) },
		{ key: "deviation", label: "Deviation", value: dev.label },
		{ key: "samples", label: "Samples", value: incident.lastSampleCount.toLocaleString() },
	]

	const entityLinks: EntityLink[] = [{ label: "View anomaly", href: `/anomalies/${incident.id}` }]
	if (incident.errorIssueId) {
		entityLinks.push({ label: "View linked issue", href: `/errors/issues/${incident.errorIssueId}` })
	}

	return {
		kind: "anomaly",
		id: incident.id,
		triage: { incidentKind: "anomaly", incidentId: incident.id },
		title: `${metric} · ${incident.serviceName}`,
		subtitle: incident.deploymentEnv || undefined,
		severity: {
			label: open && !stale ? incident.severity : stale ? "Stale" : "Resolved",
			tone: stale ? "bg-muted text-muted-foreground" : tone.badge,
		},
		status: stale
			? {
					label: `Stale · last seen ${formatRelativeTime(incident.lastTriggeredAt)}`,
					tone: "bg-muted text-muted-foreground",
				}
			: open
				? { label: "Open", tone: "bg-destructive/10 text-destructive" }
				: {
						label: incident.resolveReason
							? RESOLVE_REASON_LABEL[incident.resolveReason]
							: "Resolved",
						tone: "bg-muted text-muted-foreground",
					},
		headline: {
			label: "Deviation",
			primary: dev.label,
			secondary: `${fmt(incident.lastObservedValue)} vs ${fmt(incident.baselineMedian)} baseline`,
			bad: open && !stale,
		},
		groups: [
			{
				label: "Signal",
				rows: [
					{ label: "Metric", value: metric },
					{ label: "Observed", value: fmt(incident.lastObservedValue), mono: true },
					{ label: "Baseline", value: fmt(incident.baselineMedian), mono: true },
					{ label: "Threshold", value: fmt(incident.thresholdValue), mono: true },
					{ label: "Samples", value: incident.lastSampleCount.toLocaleString() },
				],
			},
			{
				label: "Scope",
				rows: [
					{ label: "Service", value: incident.serviceName, title: incident.serviceName },
					{ label: "Environment", value: incident.deploymentEnv || "—" },
					{
						label: "Detector",
						value: incident.detectorKey,
						mono: true,
						title: incident.detectorKey,
					},
				],
			},
		],
		entityLinks,
		chat: {
			kind: "anomaly",
			id: incident.id,
			title: `${metric} · ${incident.serviceName}`,
			severity: incident.severity,
			status: stale ? "Stale" : open ? "Open" : "Resolved",
			signalType: ANOMALY_SIGNAL_TO_CHAT[incident.signalType] ?? incident.signalType,
			scope: incident.serviceName,
			facts,
			refs: {
				serviceName: incident.serviceName,
				detectorKey: incident.detectorKey,
				...(incident.errorIssueId ? { issueId: incident.errorIssueId } : {}),
			},
		},
	}
}

/* -------------------------------------------------------------------------- */
/*  Error                                                                      */
/* -------------------------------------------------------------------------- */

const WORKFLOW_LABEL: Record<WorkflowState, string> = {
	triage: "Triage",
	todo: "Todo",
	in_progress: "In progress",
	in_review: "In review",
	done: "Done",
	cancelled: "Cancelled",
	wontfix: "Won't fix",
}

const actorLabel = (issue: ErrorIssueDocument): string =>
	issue.assignedActor?.agentName ?? (issue.assignedActor ? "Assigned" : "Unassigned")

export function subjectFromError(
	issue: ErrorIssueDocument,
	opts?: { totalInWindow?: number; latestIncidentId?: string | null },
): InvestigationSubject {
	const occurrences = issue.occurrenceCount.toLocaleString()
	const title = issue.exceptionType || "Unknown error"

	return {
		kind: "error",
		id: issue.id,
		triage: {
			incidentKind: "error",
			incidentId: opts?.latestIncidentId ?? null,
			issueId: issue.id,
		},
		title,
		subtitle: issue.serviceName,
		severity: issue.severity
			? { label: SEVERITY_LABEL[issue.severity], tone: SEVERITY_TONE[issue.severity] }
			: undefined,
		status: issue.hasOpenIncident
			? { label: "Incident open", tone: "bg-destructive/10 text-destructive" }
			: { label: WORKFLOW_LABEL[issue.workflowState], tone: "bg-muted text-muted-foreground" },
		headline: {
			label: "Occurrences",
			primary: occurrences,
			secondary:
				opts?.totalInWindow !== undefined
					? `${opts.totalInWindow.toLocaleString()} in window`
					: "total events",
		},
		groups: [
			{
				label: "Error",
				rows: [
					{ label: "Type", value: issue.exceptionType || "—", title: issue.exceptionType },
					{ label: "Service", value: issue.serviceName, title: issue.serviceName },
					...(issue.topFrame
						? [{ label: "Where", value: issue.topFrame, mono: true, title: issue.topFrame }]
						: []),
				],
			},
			{
				label: "Status",
				rows: [
					{ label: "Workflow", value: WORKFLOW_LABEL[issue.workflowState] },
					{ label: "Assignee", value: actorLabel(issue) },
				],
			},
			{
				label: "Activity",
				rows: [
					{ label: "First seen", value: formatRelativeTime(issue.firstSeenAt) },
					{ label: "Last seen", value: formatRelativeTime(issue.lastSeenAt) },
				],
			},
		],
		entityLinks: [{ label: "View issue", href: `/errors/issues/${issue.id}` }],
		chat: {
			kind: "error",
			id: issue.id,
			title,
			severity: issue.severity ?? "low",
			status: issue.hasOpenIncident ? "Open" : WORKFLOW_LABEL[issue.workflowState],
			scope: issue.serviceName,
			facts: [
				{ key: "exception", label: "Type", value: issue.exceptionType || "—" },
				{ key: "occurrences", label: "Occurrences", value: occurrences },
				{ key: "first_seen", label: "First seen", value: formatRelativeTime(issue.firstSeenAt) },
				{ key: "last_seen", label: "Last seen", value: formatRelativeTime(issue.lastSeenAt) },
			],
			refs: { serviceName: issue.serviceName, issueId: issue.id },
		},
	}
}
