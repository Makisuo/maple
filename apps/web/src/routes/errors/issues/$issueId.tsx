import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { Exit, Schema } from "effect"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { useCopy } from "@maple/ui/hooks/use-copy"

import { Button } from "@maple/ui/components/ui/button"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { CopyIcon, DotsVerticalIcon, PulseIcon } from "@/components/icons"
import { agentPromptFromIssue } from "@/components/errors/agent-debug-prompt"
import { OpenAnomalyBadge, RelatedAnomaliesSection } from "@/components/anomalies/related-anomalies-section"
import { AlertSourceCard } from "@/components/errors/alert-source-card"
import { IssueKindBadge } from "@/components/errors/kind-badge"
import { SeverityBadge } from "@/components/errors/severity-badge"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { IssueCommentComposer } from "@/components/errors/issue-comment-composer"
import { IssueIncidentsTable } from "@/components/errors/issue-incidents-table"
import { IssueOccurrenceSparkline } from "@/components/errors/issue-occurrence-sparkline"
import { IssueOccurrencesTable } from "@/components/errors/issue-occurrences-table"
import { IssueSidebar } from "@/components/errors/issue-sidebar"
import { IssueTimeline } from "@/components/errors/issue-timeline"
import { SectionHeader } from "@/components/layout/section-header"
import { WorkflowBadge } from "@/components/errors/workflow-badge"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { errorIssueDetailFromV2 } from "@/lib/services/error-issues"
import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ErrorState } from "@/components/common/error-state"
import {
	ErrorIssueId,
	ErrorIssueSetSeverityRequest,
	EscalationPolicyEvaluationRequest,
	type IssueEscalationAttemptDocument,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import {
	makeIssueClaimPayload,
	makeIssueCommentPayload,
	makeIssueReleasePayload,
	makeIssueTransitionPayload,
} from "./-issue-mutation-payloads"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"

const decodeIssueId = Schema.decodeSync(ErrorIssueId)
const ISSUE_LOADING_BREADCRUMBS = [
	{ label: "Errors", href: "/errors" },
	{ label: "Issues", href: "/errors/issues" },
	{ label: "…" },
] as const

export const Route = createFileRoute("/errors/issues/$issueId")({
	component: IssueDetailPage,
})

function IssueDetailPage() {
	const navigate = useNavigate()
	const promptCopy = useCopy({ label: "Agent prompt" })
	const { issueId: rawIssueId } = Route.useParams()
	const issueId = decodeIssueId(rawIssueId)

	const detailQueryAtom = MapleApiV2AtomClient.query("errorIssues", "retrieve", {
		params: { id: issueId },
		query: {},
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
	})
	const detailResult = useAtomValue(detailQueryAtom)
	const refreshDetail = useAtomRefresh(detailQueryAtom)

	const eventsQueryAtom = MapleApiAtomClient.query("errors", "listIssueEvents", {
		params: { issueId },
		query: { limit: 200 },
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}:events`],
	})
	const eventsResult = useAtomValue(eventsQueryAtom)
	const refreshEvents = useAtomRefresh(eventsQueryAtom)
	const investigationsQueryAtom = MapleApiV2AtomClient.query("investigations", "list", {
		query: { issue_id: issueId, limit: 10 },
		reactivityKeys: ["investigations", `errorIssue:${issueId}:investigations`],
	})
	const investigationsResult = useAtomValue(investigationsQueryAtom)
	const escalationQueryAtom = MapleApiAtomClient.query("errors", "listIssueEscalations", {
		params: { issueId },
		reactivityKeys: [`errorIssue:${issueId}:escalations`],
	})
	const escalationResult = useAtomValue(escalationQueryAtom)
	const { result: destinationsResult } = useAlertDestinationsList()

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
	const evaluateEscalation = useAtomSet(MapleApiAtomClient.mutation("errors", "evaluateEscalationPolicy"), {
		mode: "promiseExit",
	})
	const createInvestigation = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

	const [commentDraft, setCommentDraft] = useState("")
	const [busy, setBusy] = useState<
		"state" | "claim" | "release" | "heartbeat" | "comment" | "severity" | "investigation" | null
	>(null)
	const [severityConfirmation, setSeverityConfirmation] = useState<{
		readonly severity: IssueSeverity
		readonly destinationNames: ReadonlyArray<string>
	} | null>(null)

	const invalidateKeys = useMemo(
		() => [
			"errorIssues",
			`errorIssue:${issueId}`,
			`errorIssue:${issueId}:events`,
			`errorIssue:${issueId}:escalations`,
		],
		[issueId],
	)

	const transitionTo = async (next: WorkflowState) => {
		setBusy("state")
		const result = await transitionIssue({
			params: { issueId },
			payload: makeIssueTransitionPayload(next),
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
			payload: makeIssueClaimPayload(),
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
			payload: makeIssueReleasePayload(),
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Released")
		else toast.error("Release failed")
	}

	const applySeverity = async (next: IssueSeverity | null) => {
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

	const changeSeverity = async (next: IssueSeverity | null) => {
		if (next !== null) {
			const preview = await evaluateEscalation({
				payload: new EscalationPolicyEvaluationRequest({ severity: next, source: "manual" }),
			})
			if (Exit.isFailure(preview)) {
				toast.error("Could not evaluate the escalation policy. Severity was not changed.")
				return
			}
			if (preview.value.outcome === "route") {
				const destinations = Result.builder(destinationsResult)
					.onSuccess((response) => response.destinations)
					.orElse(() => [])
				const names = preview.value.destinationIds.map(
					(id) => destinations.find((destination) => destination.id === id)?.name ?? id,
				)
				setSeverityConfirmation({ severity: next, destinationNames: names })
				return
			}
		}
		await applySeverity(next)
	}

	const startInvestigation = async (params: {
		title: string
		serviceName: string
		kind: "error" | "alert"
		incidentId: string | null
		occurrences: number
	}) => {
		setBusy("investigation")
		const subject =
			params.incidentId === null
				? {
						type: "freeform" as const,
						title: params.title,
						prompt: `Investigate this issue: ${params.title}`,
						context_refs: [{ issue_id: issueId }],
					}
				: {
						type: "incident" as const,
						incident_kind: params.kind,
						incident_id: params.incidentId,
						issue_id: issueId,
					}
		const result = await createInvestigation({
			payload: {
				subject: subject as never,
				snapshot: {
					title: params.title,
					scope: params.serviceName || null,
					status: "open",
					severity: null,
					facts: [
						{ label: "Service", value: params.serviceName || "unknown" },
						{ label: "Occurrences", value: String(params.occurrences) },
					],
					references: [{ label: "Issue", url: `/errors/issues/${issueId}` }],
					incidentStartedAt: null,
					incidentEndedAt: null,
				},
			},
			reactivityKeys: ["investigations", `errorIssue:${issueId}:investigations`],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			void navigate({
				to: "/investigations/$id",
				params: { id: result.value.id },
			})
		} else {
			toast.error("Investigation could not be started")
		}
	}

	const submitComment = async () => {
		const body = commentDraft.trim()
		if (body.length === 0) return
		setBusy("comment")
		const result = await commentOnIssue({
			params: { issueId },
			payload: makeIssueCommentPayload(body),
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

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[...ISSUE_LOADING_BREADCRUMBS]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Issue" />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-4">
								<Skeleton className="h-24 w-full" />
								<Skeleton className="h-20 w-full" />
								<Skeleton className="h-40 w-full" />
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		))
		.onError((error) => (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[...ISSUE_LOADING_BREADCRUMBS]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Issue" />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<ErrorState error={error} title="Failed to load issue" onRetry={refreshDetail} />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		))
		.onSuccess((v2Detail) => {
			const detail = errorIssueDetailFromV2(v2Detail)
			const { issue, timeseries, sampleTraces, incidents } = detail
			const totalInWindow = timeseries.reduce((sum, b) => sum + b.count, 0)
			const linkedInvestigation = Result.builder(investigationsResult)
				.onSuccess((response) => response.data[0] ?? null)
				.orElse(() => null)
			const escalationAttempts = Result.builder(escalationResult)
				.onSuccess((response) => response.attempts)
				.orElse(() => [])
			const linkedEscalation = linkedInvestigation
				? (escalationAttempts.find((attempt) => attempt.investigationId === linkedInvestigation.id) ??
					null)
				: null
			const latestIncidentId =
				issue.kind === "alert"
					? typeof issue.sourceRef?.latestIncidentId === "string"
						? issue.sourceRef.latestIncidentId
						: null
					: ((incidents.find((incident) => incident.status === "open") ?? incidents[0])?.id ?? null)

			return (
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs
						items={[
							{ label: "Errors", href: "/errors" },
							{ label: "Issues", href: "/errors/issues" },
							{ label: issue.exceptionType || "Unknown error" },
						]}
					/>
					<DashboardLayout.Body>
						<DashboardLayout.Content>
							<DashboardLayout.Sticky>
								<DashboardLayout.Header
									title={issue.exceptionType || "Unknown error"}
									description={issue.serviceName}
								>
									<div className="flex items-center gap-2">
										<IssueKindBadge kind={issue.kind} />
										<SeverityBadge severity={issue.severity} />
										<WorkflowBadge state={issue.workflowState} />
										{issue.hasOpenIncident ? (
											<Badge
												variant="outline"
												className="bg-destructive/10 text-destructive"
											>
												Incident open
											</Badge>
										) : null}
										<OpenAnomalyBadge issueId={issueId} />
										{linkedInvestigation ? (
											<Button
												size="sm"
												render={
													<Link
														to="/investigations/$id"
														params={{ id: linkedInvestigation.id }}
													/>
												}
											>
												<PulseIcon className="size-3.5" />
												Open investigation
											</Button>
										) : (
											<Button
												size="sm"
												disabled={busy === "investigation"}
												onClick={() =>
													void startInvestigation({
														title: issue.exceptionType || "Unknown error",
														serviceName: issue.serviceName,
														kind: issue.kind === "alert" ? "alert" : "error",
														incidentId: latestIncidentId,
														occurrences: issue.occurrenceCount,
													})
												}
											>
												<PulseIcon className="size-3.5" />
												Start investigation
											</Button>
										)}
										{issue.kind === "error" ? (
											<DropdownMenu>
												<DropdownMenuTrigger
													render={
														<Button
															size="icon-sm"
															variant="outline"
															aria-label="More issue actions"
														/>
													}
												>
													<DotsVerticalIcon className="size-4" />
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														onClick={() => {
															void promptCopy.copy(agentPromptFromIssue(issue))
														}}
													>
														<CopyIcon className="size-3.5" />
														Copy agent prompt
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										) : null}
									</div>
								</DashboardLayout.Header>
							</DashboardLayout.Sticky>
							<DashboardLayout.Scroll>
								<div className="space-y-8">
									<section className="space-y-4">
										{issue.exceptionMessage ? (
											<p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
												{issue.exceptionMessage}
											</p>
										) : null}
										{issue.kind === "alert" ? (
											<AlertSourceCard issue={issue} />
										) : (
											<IssueOccurrenceSparkline data={timeseries} />
										)}
										<LinkedInvestigationSummary
											investigation={linkedInvestigation}
											escalation={linkedEscalation}
											onStart={() =>
												void startInvestigation({
													title: issue.exceptionType || "Unknown error",
													serviceName: issue.serviceName,
													kind: issue.kind === "alert" ? "alert" : "error",
													incidentId: latestIncidentId,
													occurrences: issue.occurrenceCount,
												})
											}
											starting={busy === "investigation"}
										/>
									</section>

									<section aria-labelledby="activity-heading">
										<SectionHeader id="activity-heading" label="Activity" />
										{Result.builder(eventsResult)
											.onError((error) => (
												<ErrorState
													error={error}
													title="Failed to load the activity timeline"
													onRetry={refreshEvents}
													variant="inline"
												/>
											))
											.onSuccess((value) => (
												<IssueTimeline
													events={value.events}
													escalations={escalationAttempts}
												/>
											))
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
											<SectionHeader
												id="occurrences-heading"
												label="Latest occurrences"
											/>
											<IssueOccurrencesTable traces={sampleTraces} />
										</section>
									) : null}
								</div>
								<AlertDialog
									open={severityConfirmation !== null}
									onOpenChange={(open) => {
										if (!open) setSeverityConfirmation(null)
									}}
								>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												Notify escalation destinations?
											</AlertDialogTitle>
											<AlertDialogDescription>
												Changing severity to {severityConfirmation?.severity} will
												notify {severityConfirmation?.destinationNames.join(", ")}.
												Manual severity changes represent explicit human intent and
												bypass AI confidence gates.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction
												onClick={() => {
													const pending = severityConfirmation
													setSeverityConfirmation(null)
													if (pending) void applySeverity(pending.severity)
												}}
											>
												Change severity and notify
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							</DashboardLayout.Scroll>
						</DashboardLayout.Content>
						<DashboardLayout.RightPanel>
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
						</DashboardLayout.RightPanel>
					</DashboardLayout.Body>
				</DashboardLayout.Root>
			)
		})
		.render()
}

function LinkedInvestigationSummary({
	investigation,
	escalation,
	onStart,
	starting,
}: {
	investigation: V2Investigation | null
	escalation: IssueEscalationAttemptDocument | null
	onStart: () => void
	starting: boolean
}) {
	if (!investigation) {
		return (
			<div className="flex items-center justify-between gap-4 border px-4 py-3">
				<div>
					<p className="text-sm font-medium text-foreground">No linked investigation</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Start an evidence-backed autonomous pass for this issue.
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={onStart} disabled={starting}>
					<PulseIcon className="size-3.5" />
					Start investigation
				</Button>
			</div>
		)
	}

	return (
		<div className="grid gap-3 border px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto]">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<p className="text-sm font-medium text-foreground">Linked investigation</p>
					<Badge variant="outline" className="capitalize">
						{investigation.status}
					</Badge>
					{investigation.confidence ? (
						<span className="text-xs capitalize text-muted-foreground">
							{investigation.confidence} confidence
						</span>
					) : null}
				</div>
				<p className="mt-1 truncate text-sm text-muted-foreground">
					{investigation.report?.suspectedCause ??
						(investigation.status === "investigating"
							? "Gathering evidence…"
							: (investigation.error ?? "No diagnosis submitted"))}
				</p>
				{escalation ? (
					<p className="mt-1 text-xs text-muted-foreground">
						Escalation: <span className="capitalize text-foreground">{escalation.status}</span>
						{escalation.deliveries.length > 0
							? ` · ${escalation.deliveries
									.map(
										(delivery) =>
											`${delivery.destinationName ?? delivery.destinationId} ${delivery.status}`,
									)
									.join(", ")}`
							: escalation.skipReason
								? ` · ${escalation.skipReason.replaceAll("_", " ")}`
								: ""}
					</p>
				) : null}
			</div>
			<Button
				size="sm"
				variant="outline"
				render={<Link to="/investigations/$id" params={{ id: investigation.id }} />}
			>
				Open investigation
			</Button>
		</div>
	)
}
