import { Link } from "@tanstack/react-router"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import { LinkIcon } from "@/components/icons"
import { shortIssueId } from "@/components/errors/issue-id"
import { formatRelativeTime } from "@/lib/format"
import {
	deviation,
	formatSignalValue,
	RESOLVE_REASON_LABEL,
	SEVERITY_TONE,
	SIGNAL_LABEL,
	severityToneFor,
	TRIAGE_STATUS_CHIP,
} from "./anomaly-format"
import { ServiceDot } from "@maple/ui/components/service-dot"

export function AnomalySidebar({
	incident,
	busy,
	onResolve,
	onOpenLinkDialog,
	onUnlink,
}: {
	incident: AnomalyIncidentDocument
	busy: boolean
	onResolve: () => void
	onOpenLinkDialog: () => void
	onUnlink: () => void
}) {
	const isOpen = incident.status === "open"
	const tone = severityToneFor(incident)
	const dev = deviation(incident)
	const triageChip = TRIAGE_STATUS_CHIP[incident.triageStatus]
	const fmt = (value: number) => formatSignalValue(incident.signalType, value)

	return (
		<div className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l bg-card/30">
			<SidebarGroup label="Actions">
				{isOpen ? (
					<Button
						size="sm"
						variant="outline"
						className="w-full"
						onClick={onResolve}
						disabled={busy}
					>
						Resolve anomaly
					</Button>
				) : null}
				{incident.errorIssueId === null ? (
					<Button
						size="sm"
						variant="outline"
						className="w-full"
						onClick={onOpenLinkDialog}
						disabled={busy}
					>
						<LinkIcon size={13} />
						Link issue
					</Button>
				) : (
					<Button size="sm" variant="outline" className="w-full" onClick={onUnlink} disabled={busy}>
						Unlink {shortIssueId(incident.errorIssueId)}
					</Button>
				)}
			</SidebarGroup>

			<SidebarGroup label="Details">
				<Row label="Signal">
					<span className="text-sm text-foreground">{SIGNAL_LABEL[incident.signalType]}</span>
				</Row>
				<Row label="Severity">
					<span className={cn("text-sm font-medium", isOpen ? tone.text : "text-muted-foreground")}>
						{incident.severity}
					</span>
				</Row>
				<Row label="Service" title={incident.serviceName}>
					<span className="flex min-w-0 items-center gap-2">
						<ServiceDot serviceName={incident.serviceName} className="size-1.5" />
						<span className="truncate text-sm text-foreground">{incident.serviceName}</span>
					</span>
				</Row>
				<Row label="Environment">
					<span className="text-sm text-foreground">{incident.deploymentEnv || "—"}</span>
				</Row>
				<Row label="Detector" title={incident.detectorKey}>
					<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
						{incident.detectorKey}
					</code>
				</Row>
				{incident.fingerprintHash !== null ? (
					<Row label="Fingerprint" title={incident.fingerprintHash}>
						<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
							{incident.fingerprintHash}
						</code>
					</Row>
				) : null}
			</SidebarGroup>

			<SidebarGroup label="Values">
				<Row label="Observed">
					<span
						className={cn(
							"font-mono text-sm tabular-nums",
							isOpen ? tone.text : "text-foreground",
						)}
					>
						{fmt(incident.lastObservedValue)}
					</span>
				</Row>
				<Row label="At open">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{fmt(incident.openedValue)}
					</span>
				</Row>
				<Row label="Baseline">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{fmt(incident.baselineMedian)}
					</span>
				</Row>
				<Row label="Threshold">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{fmt(incident.thresholdValue)}
					</span>
				</Row>
				<Row label="Deviation">
					<span
						className={cn(
							"font-mono text-sm tabular-nums",
							isOpen ? tone.text : "text-foreground",
						)}
					>
						{dev.label}
					</span>
				</Row>
				<Row label="Samples">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{incident.lastSampleCount.toLocaleString()}
					</span>
				</Row>
			</SidebarGroup>

			{incident.fingerprints.length > 1 ? (
				<SidebarGroup label={`Grouped errors · ${incident.fingerprints.length}`}>
					{incident.fingerprints.map((fingerprint) => (
						<div
							key={fingerprint.fingerprintHash}
							className="grid min-h-7 grid-cols-[1fr_auto] items-center gap-x-2 py-0.5"
							title={fingerprint.fingerprintHash}
						>
							<span className="flex min-w-0 items-center gap-1.5">
								<span
									aria-hidden
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										fingerprint.resolvedAt !== null
											? "bg-border"
											: fingerprint.severity === "critical"
												? SEVERITY_TONE.critical.accent
												: SEVERITY_TONE.warning.accent,
									)}
								/>
								{fingerprint.errorIssueId !== null ? (
									<Link
										to="/errors/issues/$issueId"
										params={{ issueId: fingerprint.errorIssueId }}
										className="truncate font-mono text-xs text-muted-foreground hover:text-foreground"
									>
										{shortIssueId(fingerprint.errorIssueId)}
									</Link>
								) : (
									<code className="truncate font-mono text-xs text-muted-foreground">
										{fingerprint.fingerprintHash.slice(0, 10)}
									</code>
								)}
							</span>
							<span className="font-mono text-xs tabular-nums text-muted-foreground">
								{fingerprint.resolvedAt !== null ? "resolved" : fmt(fingerprint.lastValue)}
							</span>
						</div>
					))}
				</SidebarGroup>
			) : null}

			<SidebarGroup label="Timing">
				<Row label="First triggered" title={new Date(incident.firstTriggeredAt).toLocaleString()}>
					<span className="text-right text-sm tabular-nums text-foreground">
						{formatRelativeTime(incident.firstTriggeredAt)}
					</span>
				</Row>
				{incident.reopenCount > 0 && incident.lastReopenedAt !== null ? (
					<Row label="Reopened" title={new Date(incident.lastReopenedAt).toLocaleString()}>
						<span className="text-right text-sm tabular-nums text-muted-foreground">
							{formatRelativeTime(incident.lastReopenedAt)}
							{incident.reopenCount > 1 ? ` (×${incident.reopenCount})` : ""}
						</span>
					</Row>
				) : null}
				<Row label="Last triggered" title={new Date(incident.lastTriggeredAt).toLocaleString()}>
					<span className="text-right text-sm tabular-nums text-foreground">
						{formatRelativeTime(incident.lastTriggeredAt)}
					</span>
				</Row>
				{incident.resolvedAt !== null ? (
					<Row label="Resolved" title={new Date(incident.resolvedAt).toLocaleString()}>
						<span className="text-right text-sm tabular-nums text-muted-foreground">
							{formatRelativeTime(incident.resolvedAt)}
						</span>
					</Row>
				) : null}
				{incident.resolveReason !== null ? (
					<Row label="Reason">
						<span className="text-right text-sm text-muted-foreground">
							{RESOLVE_REASON_LABEL[incident.resolveReason]}
						</span>
					</Row>
				) : null}
			</SidebarGroup>

			<SidebarGroup label="Triage">
				{triageChip ? (
					<span
						className={cn(
							"inline-flex h-5 w-fit items-center rounded-full px-2 text-[11px] font-medium",
							triageChip.tone,
						)}
					>
						{triageChip.label}
					</span>
				) : (
					<p className="text-xs text-muted-foreground">No AI triage has run for this incident.</p>
				)}
			</SidebarGroup>
		</div>
	)
}

function SidebarGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2 border-b border-border/40 p-4 last:border-b-0">
			<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
	return (
		<div title={title} className="grid min-h-8 grid-cols-[88px_1fr] items-center gap-x-3 py-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}
