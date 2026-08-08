import { useState } from "react"
import { Card } from "@maple/ui/components/ui/card"
import type { AiTriageResult } from "@maple/domain/http"
import { ChevronRightIcon, PulseIcon } from "@/components/icons"
import {
	ActionDetailSheet,
	EvidenceChips,
	type ProposedAction,
} from "@/components/investigations/action-detail-sheet"
import { CONFIDENCE_TONE } from "@/components/investigations/confidence-meter"
import { classifyAction } from "@/components/investigations/flow/action-target"
import { ACTION_GLYPH } from "@/components/investigations/flow/flow-nodes"

/**
 * The inline report card the investigate-mode chat renders when the agent calls
 * `submit_diagnosis`. The structured report already lives on the conversation
 * (and the investigation row) — this is its in-thread rendering, parallel to the
 * approval card. Visual language lifted from the standalone investigation report.
 */
export function DiagnosisReportCard({ report }: { report: AiTriageResult }) {
	const evidence = report.evidence.filter((e) => e.note || e.traceIds.length || e.logPatterns.length)
	// Local state, not a search param: this card renders inside the global chat
	// sheet and on routes that own no `?action=` of their own. Only the
	// investigation route, which does, makes the panel linkable.
	const [openIndex, setOpenIndex] = useState<number | null>(null)

	const actions: Array<ProposedAction> = report.suggestedActions.map((action, index) => ({
		index,
		text: action,
		// The chat card has a report, not an investigation — the affected scope is
		// the only routing fact it can offer, which is exactly why `classifyAction`
		// takes a context rather than a whole investigation.
		...classifyAction(action, { scope: report.affectedScope }),
		promise: index === report.suggestedActions.length - 1 ? "PULL REQ · SOON" : "AUTOFIX · SOON",
	}))

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
							<EvidenceChips item={item} />
						</div>
					))}
				</section>
			) : null}

			{actions.length > 0 ? (
				<section className="space-y-2">
					<h4 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
						Recommended actions
					</h4>
					<ol className="space-y-1">
						{actions.map((action) => {
							const { Icon, label } = ACTION_GLYPH[action.kind]
							return (
								<li key={action.text}>
									{/*
									 * The whole row, not a trailing affordance: the row *is* the
									 * action, and a chevron the reader has to aim at makes a
									 * one-line sentence feel like a form control.
									 */}
									<button
										type="button"
										onClick={() => setOpenIndex(action.index)}
										className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
									>
										<span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px] tabular-nums text-muted-foreground">
											{action.index + 1}
										</span>
										<Icon
											size={13}
											aria-label={label}
											className="mt-1 shrink-0 text-muted-foreground"
										/>
										<span className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
											{action.text}
										</span>
										<ChevronRightIcon
											size={13}
											className="mt-1 shrink-0 text-muted-foreground/50"
										/>
									</button>
								</li>
							)
						})}
					</ol>
				</section>
			) : null}

			<ActionDetailSheet
				action={actions.find((action) => action.index === openIndex) ?? null}
				report={report}
				open={openIndex !== null}
				onOpenChange={(next) => {
					if (!next) setOpenIndex(null)
				}}
			/>
		</Card>
	)
}
