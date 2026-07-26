import { useMemo, useState } from "react"
import { Exit } from "effect"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Separator } from "@maple/ui/components/ui/separator"
import { cn } from "@maple/ui/lib/utils"
import { toast } from "sonner"

import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import type { InvestigationContext } from "@/components/chat/investigation-context"
import { CircleWarningIcon, PulseIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { formatRelativeTime } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

const STATUS_TONE: Record<V2Investigation["status"], string> = {
	investigating: "border-primary/30 bg-primary/10 text-primary",
	diagnosed: "border-severity-ok/30 bg-severity-ok/10 text-severity-ok",
	failed: "border-destructive/30 bg-destructive/10 text-destructive",
	resolved: "text-muted-foreground",
}

const SEVERITY_TONE: Record<string, string> = {
	critical: "text-severity-critical",
	high: "text-severity-high",
	medium: "text-severity-warn",
	low: "text-muted-foreground",
}

const factKey = (label: string) =>
	label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "")

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

export function InvestigationView({
	investigation,
	onRefresh,
}: {
	investigation: V2Investigation
	onRefresh: () => void
}) {
	const [busy, setBusy] = useState<"restart" | "resolve" | null>(null)
	const restart = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "restart"), {
		mode: "promiseExit",
	})
	const updateStatus = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "updateStatus"), {
		mode: "promiseExit",
	})
	const context = useMemo(() => contextFromInvestigation(investigation), [investigation])
	const readOnly = investigation.status === "resolved"

	const handleRestart = async () => {
		setBusy("restart")
		const result = await restart({
			params: { id: investigation.id },
			reactivityKeys: ["investigations", `investigation:${investigation.id}`],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success(readOnly ? "Investigation reopened" : "Investigation restarted")
			onRefresh()
		} else {
			toast.error("Investigation could not be restarted")
		}
	}

	const handleResolve = async () => {
		setBusy("resolve")
		const result = await updateStatus({
			params: { id: investigation.id },
			payload: { status: "resolved" },
			reactivityKeys: ["investigations", `investigation:${investigation.id}`],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("Investigation resolved")
			onRefresh()
		} else {
			toast.error("Investigation could not be resolved")
		}
	}

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Investigations", href: "/investigations" },
				{ label: investigation.snapshot.title },
			]}
			title={investigation.snapshot.title}
			description={investigation.snapshot.scope ?? undefined}
			headerActions={
				<div className="flex flex-wrap items-center justify-end gap-2">
					{(investigation.severity ?? investigation.snapshot.severity) ? (
						<Badge
							variant="outline"
							className={cn(
								"capitalize",
								SEVERITY_TONE[
									investigation.severity ?? investigation.snapshot.severity ?? ""
								],
							)}
						>
							{investigation.severity ?? investigation.snapshot.severity}
						</Badge>
					) : null}
					<Badge variant="outline" className={cn("capitalize", STATUS_TONE[investigation.status])}>
						{investigation.status}
					</Badge>
					{readOnly || investigation.status === "failed" ? (
						<Button size="sm" variant="outline" onClick={handleRestart} disabled={busy !== null}>
							{readOnly ? "Reopen" : "Retry"}
						</Button>
					) : (
						<Button size="sm" variant="outline" onClick={handleResolve} disabled={busy !== null}>
							Resolve
						</Button>
					)}
				</div>
			}
		>
			<div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
				<section
					aria-label="Investigation transcript"
					className="flex min-h-[620px] flex-col overflow-hidden border bg-card/20 xl:h-[calc(100dvh-12rem)]"
				>
					<InvestigationStateBanner investigation={investigation} />
					<EscalationAudit investigation={investigation} />
					<FlueClientProvider>
						<ChatConversation
							tabId={`inv-${investigation.id}`}
							isActive
							mode="investigation"
							investigationContext={context}
							readOnly={readOnly}
							fallbackDiagnosis={investigation.report}
						/>
					</FlueClientProvider>
				</section>
				<ContextRail investigation={investigation} />
			</div>
		</DashboardLayout>
	)
}

function InvestigationStateBanner({ investigation }: { investigation: V2Investigation }) {
	if (investigation.status === "diagnosed" || investigation.status === "resolved") return null
	return (
		<div
			className={cn(
				"flex shrink-0 items-start gap-2 border-b px-4 py-3 text-sm",
				investigation.status === "failed"
					? "bg-destructive/5 text-destructive"
					: "bg-primary/5 text-muted-foreground",
			)}
		>
			{investigation.status === "failed" ? (
				<CircleWarningIcon className="mt-0.5 size-4 shrink-0" />
			) : (
				<PulseIcon className="mt-0.5 size-4 shrink-0 text-primary" />
			)}
			<div>
				<p className="font-medium text-foreground">
					{investigation.status === "failed"
						? "Autonomous pass failed"
						: "Autonomous pass in progress"}
				</p>
				<p className="mt-0.5 text-xs">
					{investigation.error ??
						"Maple is gathering evidence. Tool activity and the diagnosis appear here as they land."}
				</p>
			</div>
		</div>
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
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
					<span className="font-medium text-foreground">Escalation</span>
					<span className="capitalize text-muted-foreground">{attempt.status}</span>
					{attempt.deliveries.map((delivery) => (
						<span key={delivery.destinationId} className="text-muted-foreground">
							{delivery.destinationName ?? delivery.destinationId}{" "}
							<span
								className={
									delivery.status === "delivered" ? "text-severity-ok" : "text-destructive"
								}
							>
								{delivery.status}
							</span>
						</span>
					))}
					{attempt.skipReason ? (
						<span className="text-muted-foreground">
							{attempt.skipReason.replaceAll("_", " ")}
						</span>
					) : null}
					<span className="ml-auto text-muted-foreground">
						{attempt.attempts} attempt{attempt.attempts === 1 ? "" : "s"}
					</span>
				</div>
			)
		})
		.orElse(() => null)
}

function ContextRail({ investigation }: { investigation: V2Investigation }) {
	const snapshot = investigation.snapshot
	return (
		<aside className="border bg-card/20 xl:self-start" aria-label="Investigation context">
			<details open>
				<summary className="cursor-pointer select-none border-b px-4 py-3 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
					Context
				</summary>
				<div className="space-y-4 p-4 text-xs">
					<div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
						<span className="text-muted-foreground">Subject</span>
						<span className="break-words text-foreground">{snapshot.title}</span>
						<span className="text-muted-foreground">Origin</span>
						<span className="capitalize text-foreground">{investigation.seeded_by}</span>
						<span className="text-muted-foreground">Updated</span>
						<span className="text-foreground">
							{formatRelativeTime(investigation.updated_at)}
						</span>
						{investigation.model ? (
							<>
								<span className="text-muted-foreground">Model</span>
								<span className="break-all text-foreground">{investigation.model}</span>
							</>
						) : null}
						{investigation.confidence ? (
							<>
								<span className="text-muted-foreground">Confidence</span>
								<span className="capitalize text-foreground">{investigation.confidence}</span>
							</>
						) : null}
					</div>
					{snapshot.facts.length > 0 ? (
						<>
							<Separator />
							<div className="space-y-2">
								{snapshot.facts.map((fact) => (
									<div key={`${fact.label}:${fact.value}`}>
										<p className="text-muted-foreground">{fact.label}</p>
										<p className="mt-0.5 break-words text-foreground">{fact.value}</p>
									</div>
								))}
							</div>
						</>
					) : null}
					{snapshot.references.length > 0 ? (
						<>
							<Separator />
							<div className="space-y-1.5">
								{snapshot.references.map((reference) => (
									<a
										key={reference.url}
										href={reference.url}
										className="block truncate text-primary hover:underline"
									>
										{reference.label}
									</a>
								))}
							</div>
						</>
					) : null}
				</div>
			</details>
		</aside>
	)
}
