import { Link } from "@tanstack/react-router"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { shortIssueId } from "@/components/errors/issue-id"
import { LinkIcon } from "@/components/icons"
import { formatRelativeTime } from "@/lib/format"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	SEVERITY_TONE,
	SIGNAL_ICON,
	SIGNAL_LABEL,
	severityToneFor,
	TRIAGE_STATUS_CHIP,
} from "./anomaly-format"
import { ServiceDot } from "@maple/ui/components/service-dot"

export interface AnomalyRowProps {
	incident: AnomalyIncidentDocument
	focused?: boolean
	onFocus?: (id: string) => void
	/** Compact rows (issue detail page) drop the service + linked-issue chips. */
	variant?: "default" | "compact"
}

export function AnomalyRow({ incident, focused = false, onFocus, variant = "default" }: AnomalyRowProps) {
	const isOpen = incident.status === "open"
	const isStale = isStaleOpenIncident(incident)
	const isLive = isOpen && !isStale
	const tone = severityToneFor(incident)
	const displayTone = isStale ? SEVERITY_TONE.resolved : tone
	const dev = deviation(incident)
	const SignalIcon = SIGNAL_ICON[incident.signalType]
	const triageChip = TRIAGE_STATUS_CHIP[incident.triageStatus]
	const compact = variant === "compact"
	const activeFingerprints = incident.fingerprints.filter((f) => f.resolvedAt === null).length

	return (
		<div
			data-incident-id={incident.id}
			data-focused={focused || undefined}
			onMouseEnter={onFocus ? () => onFocus(incident.id) : undefined}
			className={cn(
				"group/row relative flex h-9 items-center gap-2 pr-3 pl-3 text-sm",
				"hover:bg-muted/50",
				"data-focused:bg-muted/40",
				"transition-colors",
			)}
		>
			<Link
				to="/anomalies/$incidentId"
				params={{ incidentId: incident.id }}
				aria-label={`${isLive ? "Open" : "Inspect"} ${isStale ? "stale " : ""}${SIGNAL_LABEL[incident.signalType]} anomaly on ${incident.serviceName}`}
				className="absolute inset-0 focus-visible:outline-none"
				tabIndex={-1}
			/>

			<span aria-hidden className={cn("absolute inset-y-0 left-0 w-px", displayTone.accent)} />

			<span className="relative z-10 flex w-3 shrink-0 items-center justify-center">
				{isLive ? (
					<span className="relative inline-flex size-1.5" title={`Open · ${incident.severity}`}>
						<span
							className={cn(
								"absolute inline-flex size-full animate-ping rounded-full opacity-60",
								tone.accent,
							)}
						/>
						<span className={cn("relative inline-flex size-full rounded-full", tone.accent)} />
					</span>
				) : (
					<span
						className="inline-flex size-1.5 rounded-full bg-border"
						title={isStale ? "Stale detector state" : "Resolved"}
					/>
				)}
			</span>

			<span className="relative z-10 flex w-[130px] shrink-0 items-center gap-1.5 font-medium text-foreground">
				<SignalIcon size={14} className="shrink-0 text-muted-foreground" />
				<span className="truncate">{SIGNAL_LABEL[incident.signalType]}</span>
			</span>

			<span
				className={cn(
					"relative z-10 w-[110px] shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums",
					isLive ? tone.text : "text-muted-foreground",
				)}
				title={`Observed ${formatSignalValue(incident.signalType, incident.lastObservedValue)} vs baseline ${formatSignalValue(incident.signalType, incident.baselineMedian)}`}
			>
				{dev.label}
			</span>

			<span className="relative z-10 hidden w-[170px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground lg:inline-block">
				{formatSignalValue(incident.signalType, incident.lastObservedValue)}
				<span className="text-muted-foreground/50"> ← </span>
				{formatSignalValue(incident.signalType, incident.baselineMedian)}
			</span>

			{!compact ? (
				<span
					className="relative z-10 hidden h-5 min-w-0 shrink items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 text-[11px] text-muted-foreground md:inline-flex"
					title={incident.serviceName}
				>
					<ServiceDot serviceName={incident.serviceName} className="size-1.5" />
					<span className="max-w-[140px] truncate">{incident.serviceName}</span>
				</span>
			) : null}

			<span className="relative z-10 hidden shrink-0 text-xs text-muted-foreground xl:inline-block">
				{incident.deploymentEnv || "—"}
			</span>

			<span className="relative z-0 min-w-0 flex-1" />

			{activeFingerprints > 1 ? (
				<span
					className="relative z-10 hidden h-5 shrink-0 items-center rounded-full border border-border/70 bg-background px-2 text-[11px] text-muted-foreground sm:inline-flex"
					title={`${activeFingerprints} error fingerprints grouped into this incident`}
				>
					{activeFingerprints} errors
				</span>
			) : null}

			{incident.reopenCount > 0 ? (
				<span
					className="relative z-10 hidden h-5 shrink-0 items-center rounded-full border border-border/70 bg-background px-2 text-[11px] text-muted-foreground sm:inline-flex"
					title="This anomaly re-breached and reopened after resolving"
				>
					reopened{incident.reopenCount > 1 ? ` ×${incident.reopenCount}` : ""}
				</span>
			) : null}

			{triageChip ? (
				<span
					className={cn(
						"relative z-10 hidden h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium sm:inline-flex",
						triageChip.tone,
					)}
				>
					{triageChip.label}
				</span>
			) : null}

			{!compact && incident.errorIssueId !== null ? (
				<Link
					to="/errors/issues/$issueId"
					params={{ issueId: incident.errorIssueId }}
					onClick={(event) => event.stopPropagation()}
					className={cn(
						"relative z-10 hidden h-5 shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background px-2 text-[11px] text-muted-foreground sm:inline-flex",
						"hover:border-border hover:text-foreground",
					)}
					title="Open linked issue"
				>
					<LinkIcon size={11} />
					{shortIssueId(incident.errorIssueId)}
				</Link>
			) : null}

			<span
				className="relative z-10 w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
				title={
					isStale
						? `Last triggered ${new Date(incident.lastTriggeredAt).toLocaleString()}`
						: `Started ${new Date(incident.firstTriggeredAt).toLocaleString()}`
				}
			>
				{isStale
					? `last seen ${formatRelativeTime(incident.lastTriggeredAt)}`
					: formatRelativeTime(incident.firstTriggeredAt)}
			</span>
		</div>
	)
}
