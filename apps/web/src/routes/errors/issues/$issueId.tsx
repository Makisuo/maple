import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Schema } from "effect"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { AiTriageCard } from "@/components/ai-triage/ai-triage-card"
import { encodeInvestigationRef } from "@/components/chat/investigation-context"
import { Button } from "@maple/ui/components/ui/button"
import { CopyIcon, PulseIcon } from "@/components/icons"
import { agentPromptFromIssue } from "@/components/errors/agent-debug-prompt"
import { OpenAnomalyBadge, RelatedAnomaliesSection } from "@/components/anomalies/related-anomalies-section"
import { AlertSourceCard } from "@/components/errors/alert-source-card"
import { IssueKindBadge } from "@/components/errors/kind-badge"
import { SeverityBadge } from "@/components/errors/severity-badge"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { IssueCommentComposer } from "@/components/errors/issue-comment-composer"
import { IssueHero } from "@/components/errors/issue-hero"
import { IssueIncidentsTable } from "@/components/errors/issue-incidents-table"
import { IssueOccurrenceSparkline } from "@/components/errors/issue-occurrence-sparkline"
import { IssueOccurrencesTable } from "@/components/errors/issue-occurrences-table"
import { IssueSidebar } from "@/components/errors/issue-sidebar"
import { IssueTimeline } from "@/components/errors/issue-timeline"
import { SectionHeader } from "@/components/layout/section-header"
import { WorkflowBadge } from "@/components/errors/workflow-badge"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import {
	ErrorIssueId,
	ErrorIssueSetSeverityRequest,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"

const decodeIssueId = Schema.decodeSync(ErrorIssueId)

export const Route = effectRoute(createFileRoute("/errors/issues/$issueId"))({
	component: IssueDetailPage,
})

function IssueDetailPage() {
	const { issueId: rawIssueId } = Route.useParams()
	const issueId = decodeIssueId(rawIssueId)

	const detailQueryAtom = MapleApiAtomClient.query("errors", "getIssue", {
		params: { issueId },
		query: {},
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
	})
	const detailResult = useAtomValue(detailQueryAtom)

	const eventsQueryAtom = MapleApiAtomClient.query("errors", "listIssueEvents", {
		params: { issueId },
		query: { limit: 200 },
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}:events`],
	})
	const eventsResult = useAtomValue(eventsQueryAtom)

	const transitionIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "transitionIssue"), {
		mode: "promiseExit",
	})
	const claimIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "claimIssue"), {
		mode: "promiseExit",
	})
	const heartbeatIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "heartbeatIssue"), {
		mode: "promiseExit",
	})
	const releaseIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "releaseIssue"), {
		mode: "promiseExit",
	})
	const commentOnIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "commentOnIssue"), {
		mode: "promiseExit",
	})
	const setIssueSeverity = useAtomSet(MapleApiAtomClient.mutation("errors", "setIssueSeverity"), {
		mode: "promiseExit",
	})

	const [commentDraft, setCommentDraft] = useState("")
	const [busy, setBusy] = useState<
		"state" | "claim" | "release" | "heartbeat" | "comment" | "severity" | null
	>(null)

	const invalidateKeys = useMemo(
		() => ["errorIssues", `errorIssue:${issueId}`, `errorIssue:${issueId}:events`],
		[issueId],
	)

	const transitionTo = async (next: WorkflowState) => {
		setBusy("state")
		const result = await transitionIssue({
			params: { issueId },
			payload: { toState: next },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success(`Moved to ${next}`)
		else toast.error("State change failed")
	}

	const claim = async () => {
		setBusy("claim")
		const result = await claimIssue({
			params: { issueId },
			payload: {},
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Claimed")
		else toast.error("Claim failed")
	}

	const heartbeat = async () => {
		setBusy("heartbeat")
		const result = await heartbeatIssue({
			params: { issueId },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Lease extended")
		else toast.error("Heartbeat failed")
	}

	const release = async () => {
		setBusy("release")
		const result = await releaseIssue({
			params: { issueId },
			payload: {},
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Released")
		else toast.error("Release failed")
	}

	const changeSeverity = async (next: IssueSeverity | null) => {
		setBusy("severity")
		const result = await setIssueSeverity({
			params: { issueId },
			payload: new ErrorIssueSetSeverityRequest({ severity: next }),
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success(next === null ? "Severity cleared" : `Severity set to ${next}`)
		} else {
			toast.error("Severity change failed")
		}
	}

	const submitComment = async () => {
		const body = commentDraft.trim()
		if (body.length === 0) return
		setBusy("comment")
		const result = await commentOnIssue({
			params: { issueId },
			payload: { body },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			setCommentDraft("")
			toast.success("Comment added")
		} else {
			toast.error("Comment failed")
		}
	}

	const breadcrumbsLoading = [
		{ label: "Errors", href: "/errors" },
		{ label: "Issues", href: "/errors/issues" },
		{ label: "…" },
	] as const

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout breadcrumbs={[...breadcrumbsLoading]} title="Issue">
				<div className="space-y-4">
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout breadcrumbs={[...breadcrumbsLoading]} title="Issue">
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Failed to load issue</EmptyTitle>
						<EmptyDescription>
							{error.message ?? "Try refreshing or check API logs."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</DashboardLayout>
		))
		.onSuccess((detail) => {
			const { issue, timeseries, sampleTraces, incidents } = detail
			const totalInWindow = timeseries.reduce((sum, b) => sum + b.count, 0)

			return (
				<DashboardLayout
					breadcrumbs={[
						{ label: "Errors", href: "/errors" },
						{ label: "Issues", href: "/errors/issues" },
						{ label: issue.exceptionType || "Unknown error" },
					]}
					title={issue.exceptionType || "Unknown error"}
					description={issue.serviceName}
					headerActions={
						<div className="flex items-center gap-2">
							<IssueKindBadge kind={issue.kind} />
							<SeverityBadge severity={issue.severity} />
							<WorkflowBadge state={issue.workflowState} />
							{issue.hasOpenIncident ? (
								<Badge variant="outline" className="bg-destructive/10 text-destructive">
									Incident open
								</Badge>
							) : null}
							<OpenAnomalyBadge issueId={issueId} />
							{issue.kind === "error" ? (
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										void navigator.clipboard
											.writeText(agentPromptFromIssue(issue))
											.then(() =>
												toast.success("Copied agent prompt — paste it into your MCP agent"),
											)
											.catch(() => toast.error("Copy failed"))
									}}
								>
									<CopyIcon className="size-3.5" />
									Copy agent prompt
								</Button>
							) : null}
							<Button
								size="sm"
								variant="outline"
								render={
									<Link
										to="/investigations/$id"
										params={{ id: issueId }}
										search={{ r: encodeInvestigationRef({ kind: "error", id: issueId, issueId }) }}
									/>
								}
							>
								<PulseIcon className="size-3.5" />
								Investigate with Maple AI
							</Button>
						</div>
					}
					rightSidebar={
						<IssueSidebar
							issue={issue}
							totalInWindow={totalInWindow}
							busy={busy}
							onTransition={transitionTo}
							onClaim={claim}
							onHeartbeat={heartbeat}
							onRelease={release}
							onSetSeverity={changeSeverity}
						/>
					}
				>
					<div className="space-y-8">
						<section className="space-y-4">
							<IssueHero issue={issue} />
							{issue.kind === "alert" ? (
								<AlertSourceCard issue={issue} />
							) : (
								<IssueOccurrenceSparkline data={timeseries} />
							)}
							<AiTriageCard
								incidentKind={issue.kind === "alert" ? "alert" : "error"}
								incidentId={
									issue.kind === "alert"
										? typeof issue.sourceRef?.latestIncidentId === "string"
											? issue.sourceRef.latestIncidentId
											: null
										: ((incidents.find((i) => i.status === "open") ?? incidents[0])?.id ??
											null)
								}
								issueId={issueId}
							/>
						</section>

						<section aria-labelledby="activity-heading">
							<SectionHeader id="activity-heading" label="Activity" />
							{Result.builder(eventsResult)
								.onError(() => (
									<div className="py-6 text-center text-sm text-destructive">
										Failed to load the activity timeline.
									</div>
								))
								.onSuccess((value) => <IssueTimeline events={value.events} />)
								.orElse(() => (
									<Skeleton className="h-20 w-full" />
								))}
							<IssueCommentComposer
								value={commentDraft}
								onChange={setCommentDraft}
								onSubmit={submitComment}
								disabled={busy === "comment"}
							/>
						</section>

						{issue.kind === "error" ? (
							<section aria-labelledby="incidents-heading">
								<SectionHeader id="incidents-heading" label="Incidents" />
								<IssueIncidentsTable incidents={incidents} />
							</section>
						) : null}

						<RelatedAnomaliesSection issueId={issueId} />

						{issue.kind === "error" ? (
							<section aria-labelledby="occurrences-heading">
								<SectionHeader id="occurrences-heading" label="Latest occurrences" />
								<IssueOccurrencesTable traces={sampleTraces} />
							</section>
						) : null}
					</div>
				</DashboardLayout>
			)
		})
		.render()
}
