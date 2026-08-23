import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { displayError } from "@/lib/error-messages"
import { Exit, Schema } from "effect"
import { useMemo, useState } from "react"
import { toastManager } from "@maple/ui/components/ui/toast"

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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { warehouseDateTimeToIso } from "@maple/query-engine"

import { RelatedAnomaliesSection } from "@/components/anomalies/related-anomalies-section"
import { ErrorState } from "@/components/common/error-state"
import { AlertSourceCard } from "@/components/errors/alert-source-card"
import { IssueCommentComposer } from "@/components/errors/issue-comment-composer"
import { IssueCulpritPanel } from "@/components/errors/issue-culprit-panel"
import { IssueFactStrip } from "@/components/errors/issue-fact-strip"
import { IssueHeader } from "@/components/errors/issue-header"
import { IssueIncidentsTable } from "@/components/errors/issue-incidents-table"
import { IssueOccurrencePanel } from "@/components/errors/issue-occurrence-panel"
import { IssueOccurrencesTable } from "@/components/errors/issue-occurrences-table"
import { IssueSidebar } from "@/components/errors/issue-sidebar"
import { ISSUE_TABS, IssueTabs, type IssueTab } from "@/components/errors/issue-tabs"
import { IssueTimeline } from "@/components/errors/issue-timeline"
import { LinkedInvestigationPanel } from "@/components/errors/linked-investigation-panel"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { errorIssueDetailFromV2 } from "@/lib/services/error-issues"
import {
	ErrorIssueId,
	ErrorIssueSetSeverityRequest,
	EscalationPolicyEvaluationRequest,
	type IssueSeverity,
	type WorkflowState,
} from "@maple/domain/http"
import type { ErrorIssueDocument } from "@maple/domain/http"
import {
	makeIssueClaimPayload,
	makeIssueCommentPayload,
	makeIssueReleasePayload,
	makeIssueTransitionPayload,
} from "./-issue-mutation-payloads"

const decodeIssueId = Schema.decodeSync(ErrorIssueId)

const ISSUE_LOADING_BREADCRUMBS = [{ label: "Errors", href: "/errors" }, { label: "…" }] as const

/**
 * How many buckets the detail chart gets. Denser than the list row's 32 — this
 * one is a full-width interactive plot, not a 56px glyph, and the shape is the
 * reason you opened the page.
 */
const CHART_BUCKETS = 48
/** Endpoint bounds on `bucket_seconds`; a range outside them is a 400. */
const MIN_BUCKET_SECONDS = 60
const MAX_BUCKET_SECONDS = 86_400
const SAMPLE_LIMIT = 50

const DEFAULT_PRESET = "12h"

const issueSearchSchema = Schema.Struct({
	tab: Schema.optional(Schema.Literals(ISSUE_TABS)),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/errors/issues/$issueId")({
	component: IssueDetailPage,
	validateSearch: Schema.toStandardSchemaV1(issueSearchSchema),
})

function IssueDetailPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? DEFAULT_PRESET}>
			<IssueDetailContent />
		</PageRefreshProvider>
	)
}

/** Warehouse-format (`YYYY-MM-DD HH:mm:ss`) to epoch ms. */
function warehouseMs(value: string): number {
	return Date.parse(value.replace(" ", "T") + "Z")
}

function IssueDetailContent() {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()
	const { issueId: rawIssueId } = Route.useParams()
	const issueId = decodeIssueId(rawIssueId)
	const tab: IssueTab = search.tab ?? "overview"

	// The detail endpoint has always taken a window — `start_time`, `end_time`,
	// `bucket_seconds`, `sample_limit` — and the page called it with `{}`. So the
	// chart, the sample traces and the rail's "Events (window)" all described
	// whatever the server defaulted to, on a page with no control to change it,
	// arrived at from a list that does have one.
	const range = useEffectiveTimeRange(search.startTime, search.endTime, search.timePreset ?? DEFAULT_PRESET)

	const chartWindow = useMemo(() => {
		const startMs = warehouseMs(range.startTime)
		const endMs = warehouseMs(range.endTime)
		const spanSeconds =
			Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
				? (endMs - startMs) / 1000
				: 12 * 3600
		const bucketSeconds = Math.min(
			MAX_BUCKET_SECONDS,
			Math.max(MIN_BUCKET_SECONDS, Math.round(spanSeconds / CHART_BUCKETS)),
		)
		return {
			startMs: Number.isFinite(startMs) ? startMs : 0,
			endMs: Number.isFinite(endMs) ? endMs : 0,
			bucketMs: bucketSeconds * 1000,
			bucketSeconds,
		}
	}, [range.startTime, range.endTime])

	const detailQuery = useMemo(
		() => ({
			// The page's range is warehouse format; the v2 contract takes ISO. Handing
			// the raw range over fails to encode and the request never leaves the
			// browser — the same trap the hub hit.
			start_time: warehouseDateTimeToIso(range.startTime),
			end_time: warehouseDateTimeToIso(range.endTime),
			bucket_seconds: chartWindow.bucketSeconds,
			sample_limit: SAMPLE_LIMIT,
		}),
		[range.startTime, range.endTime, chartWindow.bucketSeconds],
	)

	const detailQueryAtom = retainedQueryV2("errorIssues", "retrieve", {
		params: { id: issueId },
		query: detailQuery,
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
	})
	const detailResult = useAtomValue(detailQueryAtom)
	const refreshDetail = useAtomRefresh(detailQueryAtom)

	const eventsQueryAtom = retainedQuery("errors", "listIssueEvents", {
		params: { issueId },
		query: { limit: 200 },
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}:events`],
	})
	const eventsResult = useAtomValue(eventsQueryAtom)
	const refreshEvents = useAtomRefresh(eventsQueryAtom)
	const investigationsQueryAtom = retainedQueryV2("investigations", "list", {
		query: { issue_id: issueId, limit: 10 },
		reactivityKeys: ["investigations", `errorIssue:${issueId}:investigations`],
	})
	const investigationsResult = useAtomValue(investigationsQueryAtom)
	const escalationQueryAtom = retainedQuery("errors", "listIssueEscalations", {
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

	const handleTimeChange = (next: { startTime?: string; endTime?: string; presetValue?: string }) => {
		void navigate({ search: (prev) => applyTimeRangeSearch(prev, next) })
	}

	const transitionTo = async (next: WorkflowState) => {
		setBusy("state")
		const result = await transitionIssue({
			params: { issueId },
			payload: makeIssueTransitionPayload(next),
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toastManager.add({ title: `Moved to ${next}`, type: "success" })
		else toastManager.add({ title: "State change failed", type: "error" })
	}

	const claim = async () => {
		setBusy("claim")
		const result = await claimIssue({
			params: { issueId },
			payload: makeIssueClaimPayload(),
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toastManager.add({ title: "Claimed", type: "success" })
		else toastManager.add({ title: "Claim failed", type: "error" })
	}

	const heartbeat = async () => {
		setBusy("heartbeat")
		const result = await heartbeatIssue({
			params: { issueId },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toastManager.add({ title: "Lease extended", type: "success" })
		else toastManager.add({ title: "Heartbeat failed", type: "error" })
	}

	const release = async () => {
		setBusy("release")
		const result = await releaseIssue({
			params: { issueId },
			payload: makeIssueReleasePayload(),
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toastManager.add({ title: "Released", type: "success" })
		else toastManager.add({ title: "Release failed", type: "error" })
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
			toastManager.add({
				title: next === null ? "Severity cleared" : `Severity set to ${next}`,
				type: "success",
			})
		} else {
			toastManager.add({ title: "Severity change failed", type: "error" })
		}
	}

	const changeSeverity = async (next: IssueSeverity | null) => {
		if (next !== null) {
			const preview = await evaluateEscalation({
				payload: new EscalationPolicyEvaluationRequest({ severity: next, source: "manual" }),
			})
			if (Exit.isFailure(preview)) {
				toastManager.add({
					title: "Could not evaluate the escalation policy. Severity was not changed.",
					type: "error",
				})
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

	/**
	 * What this issue is called, for a human and for an agent.
	 *
	 * This used to be `issue.exceptionType || "Unknown error"`, and that fallback
	 * was the literal source of the "it's an unknown error" diagnoses: the title
	 * becomes the free-form subject's entire prompt, so an issue with no exception
	 * type briefed the agent with `Investigate this issue: Unknown error`. Both
	 * `errorLabel` and `exceptionMessage` were sitting on the row unused, and a
	 * status-message-only error — precisely the class with no exception type — is
	 * exactly the one whose label carries the only readable thing about it.
	 */
	const issueHeadline = (issue: ErrorIssueDocument): string => {
		if (issue.exceptionType && issue.exceptionMessage) {
			return `${issue.exceptionType}: ${issue.exceptionMessage}`
		}
		return issue.exceptionType || issue.exceptionMessage || issue.errorLabel || "Unlabelled error"
	}

	// Takes the whole issue rather than a handful of scraped strings. The previous
	// signature — title, serviceName, occurrences — is why the snapshot was so thin:
	// adding a field meant threading a fourth parameter through two call sites, so
	// nobody did, and the agent got a title and a service name.
	const startInvestigation = async (params: {
		issue: ErrorIssueDocument
		kind: "error" | "alert"
		incidentId: string | null
	}) => {
		setBusy("investigation")
		const issue = params.issue
		const title = issueHeadline(issue)
		const subject =
			params.incidentId === null
				? {
						type: "freeform" as const,
						title,
						prompt: `Investigate this issue: ${title}`,
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
					title,
					scope: issue.serviceName || null,
					status: "open",
					severity: issue.severity,
					facts: [
						{ label: "Service", value: issue.serviceName || "unknown" },
						{ label: "Occurrences", value: String(issue.occurrenceCount) },
						...(issue.exceptionType ? [{ label: "Exception", value: issue.exceptionType }] : []),
						...(issue.topFrame ? [{ label: "Top frame", value: issue.topFrame }] : []),
					],
					references: [{ label: "Issue", url: `/errors/issues/${issueId}` }],
					// The agent is told to scope every query to the incident interval. It
					// could not, because both of these were hardcoded null while the row
					// carried them.
					incidentStartedAt: issue.firstSeenAt,
					incidentEndedAt: issue.lastSeenAt,
					// The identifiers the agent needs to *call tools with*, as opposed to
					// the display facts above. `error_detail` takes a fingerprint and there
					// was no way for the agent to learn one.
					fingerprintHash: issue.fingerprintHash || null,
					exceptionType: issue.exceptionType || null,
					exceptionMessage: issue.exceptionMessage || null,
					topFrame: issue.topFrame || null,
					errorLabel: issue.errorLabel || null,
					occurrenceCount: issue.occurrenceCount,
					serviceName: issue.serviceName || null,
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
			const { title, message } = displayError(result)
			toastManager.add({ title, description: message, type: "error" })
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
			toastManager.add({ title: "Comment added", type: "success" })
		} else {
			toastManager.add({ title: "Comment failed", type: "error" })
		}
	}

	return Result.builder(detailResult)
		.onInitial(() => (
			<IssueShell breadcrumbs={[...ISSUE_LOADING_BREADCRUMBS]}>
				<div className="space-y-4">
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			</IssueShell>
		))
		.onError((error) => (
			<IssueShell breadcrumbs={[...ISSUE_LOADING_BREADCRUMBS]}>
				<ErrorState error={error} title="Failed to load issue" onRetry={refreshDetail} />
			</IssueShell>
		))
		.onSuccess((v2Detail) => {
			const detail = errorIssueDetailFromV2(v2Detail)
			const { issue, timeseries, sampleTraces, incidents, environments } = detail
			const totalInWindow = timeseries.reduce((sum, b) => sum + b.count, 0)
			const linkedInvestigation = Result.builder(investigationsResult)
				.onSuccess((response) => response.data[0] ?? null)
				.orElse(() => null)
			const escalationAttempts = Result.builder(escalationResult)
				.onSuccess((response) => response.attempts)
				.orElse(() => [])
			const events = Result.builder(eventsResult)
				.onSuccess((value) => value.events)
				.orElse(() => [])
			// Everyone who has spoken or acted on this issue, newest activity first,
			// so the composer's participant strip leads with whoever is here now.
			const participants = [
				...(issue.leaseHolder ? [issue.leaseHolder] : []),
				...(issue.assignedActor ? [issue.assignedActor] : []),
				...[...events].reverse().flatMap((event) => (event.actor ? [event.actor] : [])),
			]
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
			const investigate = () =>
				void startInvestigation({
					issue,
					kind: issue.kind === "alert" ? "alert" : "error",
					incidentId: latestIncidentId,
				})

			return (
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs
						items={[
							{ label: "Errors", href: "/errors" },
							{ label: issue.exceptionType || issue.errorLabel || "Unlabelled error" },
						]}
					/>
					<DashboardLayout.Body>
						<DashboardLayout.Content>
							<DashboardLayout.Sticky>
								<IssueHeader
									issue={issue}
									issueId={issueId}
									investigation={linkedInvestigation}
									search={search}
									onTimeChange={handleTimeChange}
									onStartInvestigation={investigate}
									startingInvestigation={busy === "investigation"}
								/>
								<IssueTabs
									issueId={issueId}
									active={tab}
									occurrenceCount={sampleTraces.length}
									activityCount={events.length + escalationAttempts.length}
									showOccurrences={issue.kind === "error"}
								/>
							</DashboardLayout.Sticky>
							<DashboardLayout.Scroll>
								{tab === "overview" ? (
									<div className="flex flex-col gap-7">
										<IssueCulpritPanel issue={issue} />
										<IssueFactStrip
											issue={issue}
											windowCount={totalInWindow}
											windowLabel={windowLabel(search)}
										/>
										{issue.kind === "alert" ? (
											<AlertSourceCard issue={issue} />
										) : (
											<IssueOccurrencePanel
												data={timeseries}
												severity={issue.severity}
												window={chartWindow}
											/>
										)}
										<LinkedInvestigationPanel
											investigation={linkedInvestigation}
											escalation={linkedEscalation}
											onStart={investigate}
											starting={busy === "investigation"}
										/>
										{issue.kind === "error" ? (
											<BodySection
												id="incidents"
												title="Incidents"
												count={
													incidents.length === 0
														? undefined
														: `${incidents.length} opened`
												}
											>
												<IssueIncidentsTable incidents={incidents} />
											</BodySection>
										) : null}
										<RelatedAnomaliesSection issueId={issueId} />
									</div>
								) : tab === "occurrences" ? (
									<BodySection
										id="occurrences"
										title="Latest occurrences"
										count={
											sampleTraces.length === 0
												? undefined
												: `${sampleTraces.length} sampled in this window`
										}
									>
										<IssueOccurrencesTable traces={sampleTraces} />
									</BodySection>
								) : (
									<BodySection id="activity" title="Activity">
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
											className="mt-6"
											disabled={busy === "comment"}
											onChange={setCommentDraft}
											onSubmit={submitComment}
											participants={participants}
											value={commentDraft}
										/>
									</BodySection>
								)}
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
								environments={environments}
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

/** Names the window the fact strip's "Events" lane is counting over. */
function windowLabel(search: { startTime?: string; timePreset?: string }): string {
	if (search.startTime && !search.timePreset) return "selected range"
	return search.timePreset ?? DEFAULT_PRESET
}

/** The loading and failure shells, which differ only in what they put in `Scroll`. */
function IssueShell({
	breadcrumbs,
	children,
}: {
	breadcrumbs: Array<{ label: string; href?: string }>
	children: React.ReactNode
}) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={breadcrumbs} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title="Issue" />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

/**
 * A titled block in the page body.
 *
 * `SectionHeader`'s 10px eyebrow is the rail's typography — it is what
 * `DetailRail.Group` uses — so applying it to main-column sections made the two
 * read at the same rank and left the page with no heading hierarchy at all. This
 * is the investigation page's section heading instead.
 */
function BodySection({
	id,
	title,
	count,
	children,
}: {
	id: string
	title: string
	count?: string
	children: React.ReactNode
}) {
	return (
		<section aria-labelledby={`${id}-heading`} className="flex shrink-0 flex-col gap-3.5">
			<div className="flex items-baseline gap-2.5">
				<h2
					id={`${id}-heading`}
					className="font-display text-base font-semibold tracking-[-0.01em] text-foreground"
				>
					{title}
				</h2>
				{count ? <span className="text-sm text-muted-foreground">{count}</span> : null}
			</div>
			{children}
		</section>
	)
}
