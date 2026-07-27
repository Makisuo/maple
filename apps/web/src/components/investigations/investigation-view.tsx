import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueSeverity } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Separator } from "@maple/ui/components/ui/separator"
import { toast } from "sonner"

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import type { InvestigationContext } from "@/components/chat/investigation-context"
import { SeverityBadge } from "@/components/errors/severity-badge"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { formatRelativeTime } from "@maple/ui/time-format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	InvestigationStatusBadge,
	investigationKindLabel,
	investigationOriginLabel,
} from "./investigation-status"

const factKey = (label: string) =>
	label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "")

/** Only the four canonical severities render as a badge; anything else is unset. */
const asIssueSeverity = (value: string | null | undefined): IssueSeverity | null =>
	value === "critical" || value === "high" || value === "medium" || value === "low" ? value : null

const contextFromInvestigation = (investigation: V2Investigation): InvestigationContext => {
	const subject = investigation.subject
	const kind = subject.type === "freeform" ? "freeform" : subject.incident_kind
	return {
		kind,
		id: subject.type === "freeform" ? investigation.id : subject.incident_id,
		title: investigation.snapshot.title,
		severity: investigation.severity ?? investigation.snapshot.severity ?? "unclassified",
		status: investigation.status,
		...(investigation.snapshot.scope ? { scope: investigation.snapshot.scope } : {}),
		facts: investigation.snapshot.facts.map((fact) => ({
			key: factKey(fact.label),
			label: fact.label,
			value: fact.value,
		})),
		refs:
			subject.type === "incident"
				? {
						incidentId: subject.incident_id,
						...(subject.issue_id ? { issueId: subject.issue_id } : {}),
						...(investigation.snapshot.scope
							? { serviceName: investigation.snapshot.scope }
							: {}),
					}
				: undefined,
		...(investigation.report
			? {
					aiSummary: investigation.report.summary,
					aiSuspectedCause: investigation.report.suspectedCause,
				}
			: {}),
	}
}

/**
 * One investigation, as a workspace rather than a document: the header states the
 * subject, the transcript owns the rest of the viewport and its own scrolling, and
 * the rail carries only what the transcript doesn't — provenance, references and
 * escalation. Nothing appears twice.
 */
export function InvestigationView({
	investigation,
	onRefresh,
}: {
	investigation: V2Investigation
	onRefresh: () => void
}) {
	const [busy, setBusy] = useState(false)
	const restart = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "restart"), {
		mode: "promiseExit",
	})
	const updateStatus = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "updateStatus"), {
		mode: "promiseExit",
	})
	const context = useMemo(() => contextFromInvestigation(investigation), [investigation])
	const isResolved = investigation.status === "resolved"

	const reactivityKeys = ["investigations", `investigation:${investigation.id}`]

	const handleRestart = async () => {
		setBusy(true)
		const result = await restart({ params: { id: investigation.id }, reactivityKeys })
		setBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success(isResolved ? "Investigation reopened" : "Investigation restarted")
			onRefresh()
		} else {
			toast.error("Investigation could not be restarted")
		}
	}

	const handleResolve = async () => {
		setBusy(true)
		const result = await updateStatus({
			params: { id: investigation.id },
			payload: { status: "resolved" },
			reactivityKeys,
		})
		setBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success("Investigation resolved")
			onRefresh()
		} else {
			toast.error("Investigation could not be resolved")
		}
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Investigations", href: "/investigations" },
					{ label: investigation.snapshot.title },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={<InvestigationHeading investigation={investigation} />}
						>
							{isResolved || investigation.status === "failed" ? (
								<Button size="sm" onClick={handleRestart} disabled={busy}>
									{isResolved ? "Reopen" : "Retry"}
								</Button>
							) : (
								<Button size="sm" variant="outline" onClick={handleResolve} disabled={busy}>
									Resolve
								</Button>
							)}
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					{/* `Fill`, not `Scroll`: the transcript scrolls itself. Nesting it in a
					    scrolling page is what previously needed a `calc(100dvh - 12rem)`
					    guess that the billing banners could invalidate. */}
					<DashboardLayout.Fill>
						<FlueClientProvider>
							<ChatConversation
								tabId={`inv-${investigation.id}`}
								isActive
								mode="investigation"
								investigationContext={context}
								subjectSeededByServer
								showAttachmentCard={false}
								readOnly={isResolved ? "resolved" : false}
								fallbackDiagnosis={investigation.report}
							/>
						</FlueClientProvider>
					</DashboardLayout.Fill>
				</DashboardLayout.Content>
				<DashboardLayout.RightPanel title="Investigation context">
					<ContextRail investigation={investigation} />
				</DashboardLayout.RightPanel>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/**
 * Eyebrow, title, and the snapshot facts as one line of prose-with-values —
 * following the anomaly hero rather than a grid of chips, so the subject reads as
 * a sentence and the numbers still stand out.
 */
function InvestigationHeading({ investigation }: { investigation: V2Investigation }) {
	const { snapshot } = investigation
	const severity = asIssueSeverity(investigation.severity ?? snapshot.severity)

	return (
		<div className="min-w-0 space-y-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				<span>Investigation</span>
				<span aria-hidden>·</span>
				<span>{investigationKindLabel(investigation.subject)}</span>
			</div>
			<DashboardLayout.Title title={snapshot.title}>{snapshot.title}</DashboardLayout.Title>
			<div className="flex flex-wrap items-center gap-2">
				<InvestigationStatusBadge status={investigation.status} />
				{severity ? <SeverityBadge severity={severity} /> : null}
				{snapshot.scope ? (
					<span className="font-mono text-xs text-muted-foreground">{snapshot.scope}</span>
				) : null}
			</div>
			{snapshot.facts.length > 0 ? (
				<p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted-foreground">
					{snapshot.facts.map((fact) => (
						<span key={`${fact.label}:${fact.value}`}>
							{fact.label}{" "}
							<span className="font-mono font-medium text-foreground">{fact.value}</span>
						</span>
					))}
				</p>
			) : null}
		</div>
	)
}

/**
 * What the transcript doesn't say: where this investigation came from, which model
 * produced it, what it links to, and whether an escalation went out.
 */
function ContextRail({ investigation }: { investigation: V2Investigation }) {
	const { snapshot } = investigation
	return (
		<div className="space-y-4 p-4">
			<Card className="gap-0 p-4 text-xs">
				<dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2">
					<dt className="text-muted-foreground">Origin</dt>
					<dd className="text-foreground">{investigationOriginLabel(investigation.seeded_by)}</dd>
					<dt className="text-muted-foreground">Updated</dt>
					<dd className="text-foreground">{formatRelativeTime(investigation.updated_at)}</dd>
					{investigation.confidence ? (
						<>
							<dt className="text-muted-foreground">Confidence</dt>
							<dd className="capitalize text-foreground">{investigation.confidence}</dd>
						</>
					) : null}
					{investigation.model ? (
						<>
							<dt className="text-muted-foreground">Model</dt>
							<dd className="break-all font-mono text-[11px] text-foreground">
								{investigation.model}
							</dd>
						</>
					) : null}
				</dl>
				{snapshot.references.length > 0 ? (
					<>
						<Separator className="my-3" />
						<div className="space-y-1.5">
							{snapshot.references.map((reference) => (
								<ReferenceLink
									key={reference.url}
									label={reference.label}
									url={reference.url}
								/>
							))}
						</div>
					</>
				) : null}
			</Card>
			<EscalationAudit investigation={investigation} />
		</div>
	)
}

/**
 * Snapshot references are app-relative paths written by the API, so they route
 * through the SPA. An absolute URL leaves the app and gets a plain anchor.
 */
function ReferenceLink({ label, url }: { label: string; url: string }) {
	if (!url.startsWith("/")) {
		return (
			<a
				href={url}
				rel="noreferrer"
				className="block truncate text-primary hover:underline"
				target="_blank"
			>
				{label}
			</a>
		)
	}
	return (
		<Link to={url} className="block truncate text-primary hover:underline">
			{label}
		</Link>
	)
}

function EscalationAudit({ investigation }: { investigation: V2Investigation }) {
	const issueId = investigation.subject.type === "incident" ? investigation.subject.issue_id : null
	if (!issueId) return null
	return <IssueEscalationAudit investigation={investigation} issueId={issueId} />
}

function IssueEscalationAudit({
	investigation,
	issueId,
}: {
	investigation: V2Investigation
	issueId: NonNullable<Extract<V2Investigation["subject"], { type: "incident" }>["issue_id"]>
}) {
	const result = useAtomValue(
		MapleApiAtomClient.query("errors", "listIssueEscalations", {
			params: { issueId },
			reactivityKeys: [`errorIssue:${issueId}:escalations`],
		}),
	)
	return Result.builder(result)
		.onSuccess((response) => {
			const attempt = response.attempts.find(
				(candidate) => candidate.investigationId === investigation.id,
			)
			if (!attempt) return null
			return (
				<Card className="gap-2 p-4 text-xs">
					<div className="flex items-center justify-between">
						<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
							Escalation
						</span>
						<span className="capitalize text-muted-foreground">{attempt.status}</span>
					</div>
					<ul className="space-y-1">
						{attempt.deliveries.map((delivery) => (
							<li
								key={delivery.destinationId}
								className="flex items-center justify-between gap-2"
							>
								<span className="min-w-0 truncate text-foreground">
									{delivery.destinationName ?? delivery.destinationId}
								</span>
								<span
									className={
										delivery.status === "delivered"
											? "text-severity-ok"
											: "text-destructive"
									}
								>
									{delivery.status}
								</span>
							</li>
						))}
					</ul>
					<p className="text-muted-foreground">
						{attempt.attempts} attempt{attempt.attempts === 1 ? "" : "s"}
						{attempt.skipReason ? ` · ${attempt.skipReason.replaceAll("_", " ")}` : ""}
					</p>
				</Card>
			)
		})
		.orElse(() => null)
}
