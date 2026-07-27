import { Link } from "@tanstack/react-router"
import { Card } from "@maple/ui/components/ui/card"
import type { AiTriageResult } from "@maple/domain/http"
import { PulseIcon } from "@/components/icons"

/** Shared with the investigation rail so the card and the rail never disagree. */
export const CONFIDENCE_TONE: Record<string, string> = {
	high: "text-success",
	medium: "text-severity-warn",
	low: "text-muted-foreground",
}

/**
 * The inline report card the investigate-mode chat renders when the agent calls
 * `submit_diagnosis`. The structured report already lives on the conversation
 * (and the investigation row) — this is its in-thread rendering, parallel to the
 * approval card. Visual language lifted from the standalone investigation report.
 */
export function DiagnosisReportCard({ report }: { report: AiTriageResult }) {
	const evidence = report.evidence.filter((e) => e.note || e.traceIds.length || e.logPatterns.length)

	return (
		<Card className="gap-4 border-primary/20 bg-card/60 p-5">
			<header className="space-y-1.5">
				<div className="flex items-center gap-1.5">
					<PulseIcon className="size-3.5 text-muted-foreground" />
					<span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						AI Diagnosis
					</span>
					<span className="text-muted-foreground/40">·</span>
					<span
						className={`text-[11px] font-medium capitalize ${CONFIDENCE_TONE[report.confidence] ?? ""}`}
					>
						{report.confidence} confidence
					</span>
				</div>
				<h3 className="font-display text-lg font-semibold leading-snug tracking-tight text-foreground">
					{report.suspectedCause}
				</h3>
				<p className="text-sm leading-relaxed text-muted-foreground">{report.summary}</p>
			</header>

			{report.affectedScope ? (
				<p className="text-xs text-muted-foreground">
					<span className="font-medium text-foreground">Scope:</span> {report.affectedScope}
				</p>
			) : null}

			{evidence.length > 0 ? (
				<section className="space-y-2">
					<h4 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						Evidence
					</h4>
					{evidence.map((item, index) => (
						<div key={index} className="space-y-1.5 rounded-md bg-muted/40 p-3">
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
						</div>
					))}
				</section>
			) : null}

			{report.suggestedActions.length > 0 ? (
				<section className="space-y-2">
					<h4 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						Recommended actions
					</h4>
					<ol className="space-y-2">
						{report.suggestedActions.map((action, index) => (
							<li key={action} className="flex gap-2.5 text-sm text-foreground">
								<span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px] tabular-nums text-muted-foreground">
									{index + 1}
								</span>
								<span className="leading-relaxed">{action}</span>
							</li>
						))}
					</ol>
				</section>
			) : null}
		</Card>
	)
}
