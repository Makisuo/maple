import { Link } from "@tanstack/react-router"

import { useAiTriageRun } from "@/components/ai-triage/use-ai-triage-run"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
	ArrowPathIcon,
	ArrowRightIcon,
	ChatBubbleSparkleIcon,
	CircleWarningIcon,
	PulseIcon,
} from "@/components/icons"
import { formatRelativeTime } from "@/lib/format"
import {
	type AiTriageIncidentKind,
	type AiTriageResult,
	type AiTriageRunDocument,
	type ErrorIssueId,
} from "@maple/domain/http"
import { SEVERITY_ACCENT, SEVERITY_LABEL, SEVERITY_TONE } from "@/components/errors/severity-badge"

/** Maps a failed run's machine error to a human hint. Shared with the incident report body. */
export const FAILURE_HINTS: Record<string, string> = {
	no_structured_result: "The agent did not produce a structured result within its budget.",
	workflow_binding_unavailable: "The triage workflow is not available in this environment.",
}

/** Tiny uppercase label used for section eyebrows across the triage surfaces. */
export const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"

const INCIDENT_NOUN: Record<AiTriageIncidentKind, string> = {
	alert: "alert",
	error: "error",
	anomaly: "anomaly",
}

const CONFIDENCE_FILL: Record<string, { count: number; bar: string; text: string }> = {
	high: { count: 3, bar: "bg-success", text: "text-success" },
	medium: { count: 2, bar: "bg-warning", text: "text-warning" },
	low: { count: 1, bar: "bg-muted-foreground/60", text: "text-muted-foreground" },
}

/** Three-segment certainty meter — encodes the AI's own confidence as a real signal. */
export function ConfidenceMeter({ confidence, showLabel = true }: { confidence: string; showLabel?: boolean }) {
	const tone = CONFIDENCE_FILL[confidence] ?? CONFIDENCE_FILL.low
	return (
		<div className="flex items-center gap-2" aria-label={`Confidence: ${confidence}`}>
			{showLabel ? <span className={EYEBROW}>Confidence</span> : null}
			<div className="flex items-center gap-0.5" aria-hidden>
				{[0, 1, 2].map((i) => (
					<span
						key={i}
						className={cn("h-2.5 w-1.5 rounded-[1px]", i < tone.count ? tone.bar : "bg-border")}
					/>
				))}
			</div>
			<span className={cn("text-xs font-medium capitalize", tone.text)}>{confidence}</span>
		</div>
	)
}

export interface AiTriageCardProps {
	incidentKind: AiTriageIncidentKind
	/** Incident to (re-)run triage against; null disables the run button. */
	incidentId: string | null
	issueId?: ErrorIssueId
	/**
	 * When provided, render a quiet "Ask a follow-up" action that opens an
	 * integrated chat seeded with this incident's context. Receives the latest
	 * completed triage result (if any) so the caller can fold it into the preamble.
	 */
	onOpenChat?: (result: AiTriageRunDocument["result"]) => void
}

export function AiTriageCard({ incidentKind, incidentId, issueId, onOpenChat }: AiTriageCardProps) {
	const { runsLoading, runsFailed, run, result, runActive, startRun, isStarting, refreshRuns } =
		useAiTriageRun({ incidentKind, incidentId, issueId })

	// --- Loading the run list ------------------------------------------------
	if (runsLoading) {
		return (
			<Card className="space-y-2 p-4">
				<Skeleton className="h-4 w-40" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-2/3" />
			</Card>
		)
	}

	if (runsFailed) {
		return (
			<Alert variant="warning">
				<CircleWarningIcon />
				<AlertTitle>Couldn't load the diagnosis</AlertTitle>
				<AlertDescription>Try again in a moment.</AlertDescription>
				<AlertAction>
					<Button size="sm" variant="outline" onClick={() => refreshRuns()}>
						Retry
					</Button>
				</AlertAction>
			</Alert>
		)
	}

	// --- No run yet: focused "Diagnose" CTA ----------------------------------
	if (run === null) {
		return (
			<AiTriageEmptyState
				incidentKind={incidentKind}
				incidentId={incidentId}
				isStarting={isStarting}
				onDiagnose={startRun}
			/>
		)
	}

	// --- Investigating -------------------------------------------------------
	if (runActive) {
		return <InvestigatingCard />
	}

	// --- Failed --------------------------------------------------------------
	if (run.status === "failed") {
		return (
			<Alert variant="error">
				<CircleWarningIcon />
				<AlertTitle>Diagnosis failed</AlertTitle>
				<AlertDescription>
					{FAILURE_HINTS[run.error ?? ""] ?? `Triage failed: ${run.error ?? "unknown error"}`}
				</AlertDescription>
				<AlertAction>
					<Button size="sm" variant="outline" onClick={startRun} disabled={isStarting}>
						Retry
					</Button>
				</AlertAction>
			</Alert>
		)
	}

	if (!result) {
		// Completed without a structured result — shouldn't happen, but degrade gracefully.
		return (
			<Alert variant="warning">
				<CircleWarningIcon />
				<AlertTitle>No diagnosis produced</AlertTitle>
				<AlertDescription>The investigation finished without a structured result.</AlertDescription>
				<AlertAction>
					<Button size="sm" variant="outline" onClick={startRun} disabled={isStarting}>
						Re-run
					</Button>
				</AlertAction>
			</Alert>
		)
	}

	return <DiagnosisReadout run={run} result={result} onOpenChat={onOpenChat} onRerun={startRun} rerunning={isStarting} />
}

/** The "investigating…" placeholder, shared by the active-run and auto-start states. */
export function InvestigatingCard() {
	return (
		<Card className="space-y-2 p-4">
			<div className="flex items-center gap-2">
				<Spinner className="size-4 text-muted-foreground" />
				<Shimmer className="text-sm font-medium">
					Investigating — reading traces, errors, and logs
				</Shimmer>
			</div>
			<div className="space-y-1.5">
				<Skeleton className="h-3 w-3/4" />
				<Skeleton className="h-3 w-1/2" />
			</div>
		</Card>
	)
}

/** Empty (no-run) state — the focused "Diagnose" CTA. */
function AiTriageEmptyState({
	incidentKind,
	incidentId,
	isStarting,
	onDiagnose,
}: {
	incidentKind: AiTriageIncidentKind
	incidentId: string | null
	isStarting: boolean
	onDiagnose: () => void
}) {
	return (
		<Card>
			<Empty className="py-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<PulseIcon size={18} />
					</EmptyMedia>
					<EmptyTitle>No diagnosis yet</EmptyTitle>
					<EmptyDescription>
						See what's driving this {INCIDENT_NOUN[incidentKind]} — Maple reads the traces,
						errors, and logs to find the likely cause.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button size="sm" onClick={onDiagnose} disabled={incidentId === null || isStarting}>
						<PulseIcon className="size-3.5" />
						Diagnose this {INCIDENT_NOUN[incidentKind]}
					</Button>
					{incidentId === null ? (
						<p className="text-xs text-muted-foreground">No incident to diagnose yet.</p>
					) : null}
				</EmptyContent>
			</Empty>
		</Card>
	)
}

function DiagnosisReadout({
	run,
	result,
	onOpenChat,
	onRerun,
	rerunning,
}: {
	run: AiTriageRunDocument
	result: AiTriageResult
	onOpenChat?: (result: AiTriageRunDocument["result"]) => void
	onRerun: () => void
	rerunning: boolean
}) {
	const severity = result.severityAssessment
	// Aggregate the services named across all evidence into one blast-radius row.
	const services = [...new Set(result.evidence.flatMap((e) => e.relatedServices))]
	const traceEvidence = result.evidence.filter((e) => e.note || e.traceIds.length || e.logPatterns.length)

	return (
		<Card className="relative gap-0 overflow-hidden p-0">
			<span aria-hidden className={cn("absolute inset-y-0 left-0 z-10 w-1", SEVERITY_ACCENT[severity])} />

			{/* Banner — what's wrong, front and center */}
			<div className="space-y-1.5 px-4 py-3 pl-5">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<span className="flex items-center gap-1.5">
							<PulseIcon className="size-3.5 text-muted-foreground" />
							<span className={EYEBROW}>AI Diagnosis</span>
						</span>
						<Badge variant="outline" className={cn("capitalize", SEVERITY_TONE[severity])}>
							{SEVERITY_LABEL[severity]}
						</Badge>
						<span className="text-muted-foreground/40">·</span>
						<span className="truncate text-xs text-muted-foreground">
							{formatRelativeTime(run.completedAt ?? run.createdAt)}
							{run.model ? ` · ${run.model}` : ""}
						</span>
					</div>
					<ConfidenceMeter confidence={result.confidence} showLabel={false} />
				</div>
				<p className="text-sm font-medium leading-snug text-foreground">{result.suspectedCause}</p>
				<p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{result.summary}</p>
			</div>

			{/* Blast radius */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-2.5 pl-5">
				<span className={EYEBROW}>Blast radius</span>
				<span className="text-[13px] text-foreground">{result.affectedScope}</span>
				{services.length > 0 ? (
					<div className="flex flex-wrap gap-1">
						{services.map((service) => (
							<Badge key={service} variant="outline" className="text-[11px]">
								{service}
							</Badge>
						))}
					</div>
				) : null}
			</div>

			{/* Evidence */}
			{traceEvidence.length > 0 ? (
				<div className="space-y-1.5 px-4 pb-2.5 pl-5">
					<span className={EYEBROW}>Evidence</span>
					<ul className="space-y-1.5">
						{traceEvidence.map((item, index) => (
							<li key={index} className="space-y-1">
								{item.note ? (
									<p className="text-[13px] leading-snug text-muted-foreground">{item.note}</p>
								) : null}
								{item.traceIds.length || item.logPatterns.length ? (
									<div className="flex flex-wrap items-center gap-1">
										{item.traceIds.map((traceId) => (
											<Link
												key={traceId}
												to="/traces/$traceId"
												params={{ traceId }}
												className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-muted/70"
											>
												{traceId.slice(0, 12)}…
											</Link>
										))}
										{item.logPatterns.map((pattern) => (
											<span
												key={pattern}
												className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
											>
												{pattern}
											</span>
										))}
									</div>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}

			{/* Runbook */}
			{result.suggestedActions.length > 0 ? (
				<div className="space-y-1.5 px-4 pb-3 pl-5">
					<span className={EYEBROW}>What to do</span>
					<ol className="space-y-1.5">
						{result.suggestedActions.map((action, index) => (
							<li key={action} className="flex gap-2 text-[13px] text-foreground">
								<span className="mt-px flex size-4 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] tabular-nums text-muted-foreground">
									{index + 1}
								</span>
								<span className="leading-snug">{action}</span>
							</li>
						))}
					</ol>
				</div>
			) : null}

			{/* Quiet footer */}
			<div className="flex items-center justify-between gap-2 border-t border-border px-2.5 py-1.5 pl-4">
				<Button
					size="sm"
					variant="ghost"
					onClick={onRerun}
					disabled={rerunning}
					className="text-muted-foreground"
				>
					<ArrowPathIcon className="size-3.5" />
					Re-run
				</Button>
				{onOpenChat ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => onOpenChat(result)}
						className="text-muted-foreground"
					>
						<ChatBubbleSparkleIcon className="size-3.5" />
						Ask a follow-up
						<ArrowRightIcon className="size-3" />
					</Button>
				) : null}
			</div>
		</Card>
	)
}
