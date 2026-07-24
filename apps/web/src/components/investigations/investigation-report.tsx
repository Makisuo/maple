import { Link } from "@tanstack/react-router"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { AiTriageResult, AiTriageRunDocument } from "@maple/domain/http"

import { CircleWarningIcon, PulseIcon } from "@/components/icons"
import { EYEBROW, FAILURE_HINTS, InvestigatingCard } from "@/components/ai-triage/ai-triage-card"
import type { AiTriageRunState } from "@/components/ai-triage/use-ai-triage-run"
import { SectionHeader } from "@/components/layout/section-header"
import { formatRelativeTime } from "@/lib/format"

export interface InvestigationReportProps {
	triage: AiTriageRunState
}

/**
 * The report body for an investigation — the AI's verdict as a thesis headline,
 * lead summary, evidence cards, and a numbered runbook. Drives the full run state
 * machine for the center column; the success case is the report itself. Kind-agnostic.
 */
export function InvestigationReport({ triage }: InvestigationReportProps) {
	const { runsLoading, runsFailed, run, result, runActive, canRun, startRun, isStarting, refreshRuns } =
		triage

	if (runsLoading) {
		return (
			<div className="mx-auto w-full max-w-3xl space-y-4">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-2/3" />
			</div>
		)
	}

	if (runsFailed) {
		return (
			<Alert variant="warning" className="mx-auto max-w-3xl">
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

	// No run, and none can be started (e.g. an error issue with no incident) — a
	// terminal state, not an endless spinner. The chat rail is still usable.
	if (run === null && !canRun) {
		return (
			<Card className="mx-auto max-w-3xl">
				<Empty className="py-8">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<PulseIcon size={18} />
						</EmptyMedia>
						<EmptyTitle>No automatic diagnosis yet</EmptyTitle>
						<EmptyDescription>
							This issue hasn't opened an incident, so there's nothing to diagnose
							automatically. You can still ask Maple AI about it in the chat.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</Card>
		)
	}

	// No run yet (but runnable) → the page auto-starts one on arrival, so show the
	// investigating state, as well as while a run is active.
	if (run === null || runActive) {
		return (
			<div className="mx-auto w-full max-w-3xl">
				<InvestigatingCard />
			</div>
		)
	}

	if (run.status === "failed") {
		return (
			<Alert variant="error" className="mx-auto max-w-3xl">
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
		return (
			<Alert variant="warning" className="mx-auto max-w-3xl">
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

	return <Report run={run} result={result} />
}

function Report({ run, result }: { run: AiTriageRunDocument; result: AiTriageResult }) {
	const evidence = result.evidence.filter((e) => e.note || e.traceIds.length || e.logPatterns.length)

	return (
		<article className="mx-auto w-full max-w-3xl space-y-9">
			<header className="space-y-3">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="flex items-center gap-1.5">
						<PulseIcon className="size-3.5 text-muted-foreground" />
						<span className={EYEBROW}>AI Diagnosis</span>
					</span>
					<span className="text-muted-foreground/40">·</span>
					<span className="text-xs text-muted-foreground">
						investigated {formatRelativeTime(run.completedAt ?? run.createdAt)}
						{run.model ? ` · ${run.model}` : ""}
					</span>
				</div>
				<h2 className="font-display text-2xl font-semibold leading-[1.15] tracking-tight text-foreground">
					{result.suspectedCause}
				</h2>
				<p className="text-[15px] leading-relaxed text-muted-foreground">{result.summary}</p>
			</header>

			{evidence.length > 0 ? (
				<section aria-labelledby="evidence-heading">
					<SectionHeader id="evidence-heading" label="Evidence" />
					<div className="space-y-3">
						{evidence.map((item, index) => (
							<Card key={index} className="gap-2.5 p-4">
								{item.note ? (
									<p className="text-sm leading-relaxed text-foreground">{item.note}</p>
								) : null}
								{item.traceIds.length || item.logPatterns.length ? (
									<div className="flex flex-wrap items-center gap-1.5">
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
							</Card>
						))}
					</div>
				</section>
			) : null}

			{result.suggestedActions.length > 0 ? (
				<section aria-labelledby="actions-heading">
					<SectionHeader id="actions-heading" label="Recommended actions" />
					<ol className="space-y-2.5">
						{result.suggestedActions.map((action, index) => (
							<li key={action} className="flex gap-3 text-sm text-foreground">
								<span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px] tabular-nums text-muted-foreground">
									{index + 1}
								</span>
								<span className="leading-relaxed">{action}</span>
							</li>
						))}
					</ol>
				</section>
			) : null}
		</article>
	)
}
