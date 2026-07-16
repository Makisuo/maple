import { Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import type { AnomalyIncidentDocument, ErrorIssueId } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { ActorAvatar } from "@/components/errors/actor-chip"
import { shortIssueId } from "@/components/errors/issue-id"
import { WorkflowBadge } from "@/components/errors/workflow-badge"
import { ArrowRightIcon, LinkIcon, XmarkIcon } from "@/components/icons"
import { formatNumber } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { ServiceDot } from "@maple/ui/components/service-dot"

export function AnomalyLinkedIssueCard({
	incident,
	onOpenLinkDialog,
	onUnlink,
	busy,
}: {
	incident: AnomalyIncidentDocument
	onOpenLinkDialog: () => void
	onUnlink: () => void
	busy: boolean
}) {
	if (incident.errorIssueId === null) {
		return (
			<div className="rounded-md border border-dashed border-border/70 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="space-y-1">
						<p className="text-sm text-foreground">Not linked to an issue</p>
						<p className="text-xs text-muted-foreground">
							{incident.signalType === "error_spike"
								? "This spike is fingerprint-scoped — an issue with this fingerprint may already exist for the service."
								: "Escalate this anomaly by linking it to an existing error issue."}
						</p>
						{incident.fingerprintHash !== null ? (
							<code className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
								fingerprint {incident.fingerprintHash}
							</code>
						) : null}
					</div>
					<Button size="sm" variant="outline" onClick={onOpenLinkDialog} disabled={busy}>
						<LinkIcon size={13} />
						Link issue
					</Button>
				</div>
			</div>
		)
	}

	return (
		<LinkedIssueBody
			issueId={incident.errorIssueId}
			onOpenLinkDialog={onOpenLinkDialog}
			onUnlink={onUnlink}
			busy={busy}
		/>
	)
}

function LinkedIssueBody({
	issueId,
	onOpenLinkDialog,
	onUnlink,
	busy,
}: {
	issueId: ErrorIssueId
	onOpenLinkDialog: () => void
	onUnlink: () => void
	busy: boolean
}) {
	const issueQueryAtom = MapleApiAtomClient.query("errors", "getIssue", {
		params: { issueId },
		query: {},
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
	})
	const issueResult = useAtomValue(issueQueryAtom)

	return (
		<Card>
			<CardContent className="space-y-3 p-4 text-sm">
				{Result.builder(issueResult)
					.onInitial(() => <Skeleton className="h-12 w-full" />)
					.onError(() => (
						<div className="flex items-center justify-between gap-3">
							<p className="text-muted-foreground">
								Linked to issue{" "}
								<code className="font-mono text-xs">{shortIssueId(issueId)}</code> — failed to
								load its details.
							</p>
							<IssueCardActions
								issueId={issueId}
								onOpenLinkDialog={onOpenLinkDialog}
								onUnlink={onUnlink}
								busy={busy}
							/>
						</div>
					))
					.onSuccess(({ issue }) => (
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="min-w-0 space-y-2">
								<div className="flex flex-wrap items-center gap-2">
									<WorkflowBadge state={issue.workflowState} />
									<code className="font-mono text-xs tabular-nums text-muted-foreground">
										{shortIssueId(issue.id)}
									</code>
									<span className="inline-flex h-5 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2 text-[11px] text-muted-foreground">
										<ServiceDot serviceName={issue.serviceName} className="size-1.5" />
										<span className="max-w-[140px] truncate">{issue.serviceName}</span>
									</span>
								</div>
								<p className="min-w-0 truncate font-medium text-foreground">
									{issue.exceptionType || "Unknown error"}
									{issue.exceptionMessage ? (
										<span className="ml-2 font-normal text-muted-foreground">
											{issue.exceptionMessage}
										</span>
									) : null}
								</p>
								<div className="flex items-center gap-3 text-xs text-muted-foreground">
									<span className="tabular-nums">
										{formatNumber(issue.occurrenceCount)} events
									</span>
									<span className="flex items-center gap-1.5">
										<ActorAvatar actor={issue.leaseHolder ?? issue.assignedActor} />
										{issue.leaseHolder || issue.assignedActor ? null : "Unclaimed"}
									</span>
								</div>
							</div>
							<IssueCardActions
								issueId={issueId}
								onOpenLinkDialog={onOpenLinkDialog}
								onUnlink={onUnlink}
								busy={busy}
							/>
						</div>
					))
					.render()}
			</CardContent>
		</Card>
	)
}

function IssueCardActions({
	issueId,
	onOpenLinkDialog,
	onUnlink,
	busy,
}: {
	issueId: ErrorIssueId
	onOpenLinkDialog: () => void
	onUnlink: () => void
	busy: boolean
}) {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<Button
				size="sm"
				variant="outline"
				render={<Link to="/errors/issues/$issueId" params={{ issueId }} />}
			>
				Open issue
				<ArrowRightIcon size={13} />
			</Button>
			<Button
				size="sm"
				variant="ghost"
				onClick={onOpenLinkDialog}
				disabled={busy}
				title="Link a different issue"
			>
				<LinkIcon size={13} />
			</Button>
			<Button size="sm" variant="ghost" onClick={onUnlink} disabled={busy} title="Unlink issue">
				<XmarkIcon size={13} />
			</Button>
		</div>
	)
}
