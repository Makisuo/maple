import { useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatBackendError } from "@/lib/error-messages"
import { Exit, Schema } from "effect"
import { toastManager } from "@maple/ui/components/ui/toast"

import { PulseIcon } from "@/components/icons"
import { AnomalyHero } from "@/components/anomalies/anomaly-hero"
import { AnomalyLinkIssueDialog } from "@/components/anomalies/anomaly-link-issue-dialog"
import { AnomalyLinkedIssueCard } from "@/components/anomalies/anomaly-linked-issue-card"
import { AnomalySidebar } from "@/components/anomalies/anomaly-sidebar"
import { AnomalyTimeseriesChart } from "@/components/anomalies/anomaly-timeseries-chart"
import {
	isStaleOpenIncident,
	RESOLVE_REASON_LABEL,
	SEVERITY_TONE,
	SIGNAL_LABEL,
	severityToneFor,
} from "@/components/anomalies/anomaly-format"
import { useAnomalyMutations } from "@/components/anomalies/use-anomaly-mutations"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { SectionHeader } from "@/components/layout/section-header"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
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
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { AnomalyIncidentId, type AnomalyIncidentDocument, type ErrorIssueId } from "@maple/domain/http"

const decodeIncidentId = Schema.decodeSync(AnomalyIncidentId)
const LIVE_REFRESH_INTERVAL_MS = 15_000
const ANOMALY_LOADING_BREADCRUMBS = [{ label: "Anomalies", href: "/anomalies" }, { label: "…" }] as const

export const Route = createFileRoute("/anomalies/$incidentId")({
	component: AnomalyDetailPage,
})

function AnomalyDetailPage() {
	const { incidentId: rawIncidentId } = Route.useParams()
	const incidentId = decodeIncidentId(rawIncidentId)

	const incidentQueryAtom = MapleApiAtomClient.query("anomalies", "getIncident", {
		params: { incidentId },
		reactivityKeys: ["anomalyIncidents", `anomalyIncident:${incidentId}`],
	})
	const incidentResult = useAtomValue(incidentQueryAtom)
	const refreshIncident = useAtomRefresh(incidentQueryAtom)

	const isOpen = Result.builder(incidentResult)
		.onSuccess((incident) => incident.status === "open")
		.orElse(() => false)

	// Live monitor: keep an open incident fresh while the page is visible.
	useIntervalRefresh(refreshIncident, {
		intervalMs: LIVE_REFRESH_INTERVAL_MS,
		enabled: isOpen,
	})

	return Result.builder(incidentResult)
		.onInitial(() => (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[...ANOMALY_LOADING_BREADCRUMBS]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Anomaly" />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-4">
								<Skeleton className="h-24 w-full" />
								<Skeleton className="h-64 w-full" />
								<Skeleton className="h-32 w-full" />
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		))
		.onError((error) => (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[...ANOMALY_LOADING_BREADCRUMBS]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Anomaly" />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<Empty>
								<EmptyHeader>
									<EmptyTitle>
										{error._tag === "@maple/http/anomalies/AnomalyIncidentNotFoundError"
											? "Anomaly not found"
											: "Failed to load anomaly"}
									</EmptyTitle>
									<EmptyDescription>
										{error._tag === "@maple/http/anomalies/AnomalyIncidentNotFoundError"
											? "It may have been pruned, or the link is stale."
											: (error.message ?? "Try refreshing or check API logs.")}
									</EmptyDescription>
								</EmptyHeader>
								<Button variant="outline" size="sm" render={<Link to="/anomalies" />}>
									Back to anomalies
								</Button>
							</Empty>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		))
		.onSuccess((incident) => <AnomalyDetailBody incident={incident} incidentId={incidentId} />)
		.render()
}

function AnomalyDetailBody({
	incident,
	incidentId,
}: {
	incident: AnomalyIncidentDocument
	incidentId: AnomalyIncidentId
}) {
	const mutations = useAnomalyMutations()
	const [linkDialogOpen, setLinkDialogOpen] = useState(false)
	const [resolveConfirmOpen, setResolveConfirmOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const navigate = useNavigate()
	const createInvestigation = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

	const isOpen = incident.status === "open"
	const isStale = isStaleOpenIncident(incident)
	const tone = severityToneFor(incident)

	const timeseriesQueryAtom = MapleApiAtomClient.query("anomalies", "getIncidentTimeseries", {
		params: { incidentId },
		query: {},
		reactivityKeys: [`anomalyIncident:${incidentId}:timeseries`],
	})
	const timeseriesResult = useAtomValue(timeseriesQueryAtom)
	const refreshTimeseries = useAtomRefresh(timeseriesQueryAtom)

	useIntervalRefresh(refreshTimeseries, {
		intervalMs: LIVE_REFRESH_INTERVAL_MS,
		enabled: isOpen,
	})

	const resolve = async () => {
		setBusy(true)
		try {
			await mutations.resolveIncident(incidentId)
			setResolveConfirmOpen(false)
		} finally {
			setBusy(false)
		}
	}

	const linkTo = async (issueId: ErrorIssueId) => {
		setBusy(true)
		try {
			const result = await mutations.linkIssue(incidentId, issueId, incident.errorIssueId)
			if (Exit.isSuccess(result)) setLinkDialogOpen(false)
		} finally {
			setBusy(false)
		}
	}

	const unlink = async () => {
		setBusy(true)
		try {
			await mutations.linkIssue(incidentId, null, incident.errorIssueId)
		} finally {
			setBusy(false)
		}
	}

	const investigate = async () => {
		setBusy(true)
		try {
			const result = await createInvestigation({
				payload: {
					subject: {
						type: "incident",
						incident_kind: "anomaly",
						incident_id: incidentId,
						...(incident.errorIssueId ? { issue_id: incident.errorIssueId } : {}),
					} as never,
					snapshot: {
						title: `${SIGNAL_LABEL[incident.signalType]} · ${incident.serviceName}`,
						scope: incident.deploymentEnv || incident.serviceName,
						status: incident.status,
						severity: incident.severity === "critical" ? "critical" : "medium",
						facts: [
							{ label: "Signal", value: incident.signalType },
							{ label: "Service", value: incident.serviceName },
							{ label: "Last observed", value: String(incident.lastObservedValue) },
						],
						references: incident.errorIssueId
							? [{ label: "Issue", url: `/errors/issues/${incident.errorIssueId}` }]
							: [],
						incidentStartedAt: incident.firstTriggeredAt,
						incidentEndedAt: incident.resolvedAt,
					},
				},
				reactivityKeys: ["investigations"],
			})
			if (Exit.isSuccess(result)) {
				await navigate({ to: "/investigations/$id", params: { id: result.value.id } })
				return
			}
			const { title, description } = formatBackendError(result)
			toastManager.add({ title, description, type: "error" })
		} finally {
			setBusy(false)
		}
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Anomalies", href: "/anomalies" },
					{ label: `${incident.serviceName} · ${SIGNAL_LABEL[incident.signalType]}` },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title={`${SIGNAL_LABEL[incident.signalType]} · ${incident.serviceName}`}
							description={incident.deploymentEnv || undefined}
						>
							<div className="flex items-center gap-2">
								<Badge
									variant="outline"
									className={isStale ? SEVERITY_TONE.resolved.badge : tone.badge}
								>
									{isOpen && !isStale ? (
										<span className="flex items-center gap-1.5">
											<span className="relative inline-flex size-1.5">
												<span
													className={cn(
														"absolute inline-flex size-full animate-ping rounded-full opacity-60",
														tone.accent,
													)}
												/>
												<span
													className={cn(
														"relative inline-flex size-full rounded-full",
														tone.accent,
													)}
												/>
											</span>
											{incident.severity}
										</span>
									) : isStale ? (
										`Stale · last seen ${formatRelativeTime(incident.lastTriggeredAt)}`
									) : incident.resolveReason !== null ? (
										RESOLVE_REASON_LABEL[incident.resolveReason]
									) : (
										"Resolved"
									)}
								</Badge>
								<Button
									size="sm"
									variant="outline"
									onClick={() => void investigate()}
									disabled={busy}
								>
									<PulseIcon className="size-3.5" />
									{busy ? "Opening…" : "Open investigation"}
								</Button>
								{isOpen ? (
									<Button
										size="sm"
										variant="outline"
										onClick={() => setResolveConfirmOpen(true)}
										disabled={busy}
									>
										Resolve
									</Button>
								) : null}
							</div>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="space-y-8">
							<section className="space-y-4">
								<AnomalyHero incident={incident} />
								{Result.builder(timeseriesResult)
									.onInitial(() => <Skeleton className="h-64 w-full" />)
									.onError(() => (
										<div className="flex h-64 w-full items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground">
											Failed to load signal data.
										</div>
									))
									.onSuccess((timeseries) => (
										<AnomalyTimeseriesChart incident={incident} timeseries={timeseries} />
									))
									.render()}
							</section>

							<section aria-labelledby="linked-issue-heading">
								<SectionHeader id="linked-issue-heading" label="Linked issue" />
								<AnomalyLinkedIssueCard
									incident={incident}
									onOpenLinkDialog={() => setLinkDialogOpen(true)}
									onUnlink={unlink}
									busy={busy}
								/>
							</section>
						</div>

						<AnomalyLinkIssueDialog
							incident={incident}
							open={linkDialogOpen}
							onOpenChange={setLinkDialogOpen}
							onSelect={linkTo}
						/>

						<AlertDialog open={resolveConfirmOpen} onOpenChange={setResolveConfirmOpen}>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Resolve this anomaly?</AlertDialogTitle>
									<AlertDialogDescription>
										The incident is marked resolved manually
										{incident.fingerprints.filter((f) => f.resolvedAt === null).length > 1
											? ", including every error fingerprint grouped into it"
											: ""}
										. If the signal keeps deviating, the detector waits out a one-hour
										cooldown before re-opening it.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
									<AlertDialogAction onClick={resolve} disabled={busy}>
										Resolve
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
				<DashboardLayout.RightPanel>
					<AnomalySidebar
						incident={incident}
						busy={busy}
						onResolve={() => setResolveConfirmOpen(true)}
						onOpenLinkDialog={() => setLinkDialogOpen(true)}
						onUnlink={unlink}
					/>
				</DashboardLayout.RightPanel>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
