import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { CauseRecap } from "./cause-recap"
import { ConfidenceMeter } from "./confidence-meter"
import type { LensVerdict } from "@maple/domain/http"
import { lensCopy } from "./lens-catalogue"
import { lensTally } from "./lens-derive"

const VERDICT_LABEL: Record<LensVerdict, string> = {
	promoted: "Promoted",
	merged: "Merged",
	ruled_out: "Ruled out",
	rejected: "Rejected",
	pending: "Running",
}

const VERDICT_TONE: Record<LensVerdict, string> = {
	promoted: "bg-success/12 text-success",
	merged: "bg-muted text-muted-foreground",
	ruled_out: "bg-muted text-muted-foreground",
	rejected: "bg-destructive/12 text-destructive",
	pending: "bg-primary/10 text-primary",
}

const VERDICT_DOT: Record<LensVerdict, string> = {
	promoted: "bg-success",
	merged: "bg-muted-foreground/60",
	ruled_out: "bg-muted-foreground/40",
	rejected: "bg-destructive",
	pending: "bg-primary animate-pulse",
}

/**
 * The trust payload. A promoted cause on its own asks to be believed; this table
 * shows the obvious alternative was dispatched, what it claimed, and the one-line
 * reason it lost. A struck-through claim was *made and then rejected* — which is
 * a stronger statement than never having been considered.
 *
 * Never rendered at a fan-out of one: with no rivals there is nothing to rank,
 * and `InvestigationTabs` drops the tab entirely.
 */
export function HypothesesTab({ investigation }: { investigation: V2Investigation }) {
	const lenses = investigation.lens_runs
	const tally = lensTally(lenses)
	const size = investigation.fanout.size

	return (
		<div className="flex shrink-0 flex-col gap-6">
			<CauseRecap investigation={investigation} />
			<section className="flex shrink-0 flex-col gap-3.5">
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<div className="flex items-baseline gap-2.5">
						<h2 className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
							Hypotheses considered
						</h2>
						<span className="text-sm text-muted-foreground">{summarise(tally)}</span>
					</div>
					<span className="text-sm text-muted-foreground">
						Fan-out scaled to {size} {size === 1 ? "lens" : "lenses"}
					</span>
				</div>
				<ul className="flex flex-col border-t">
					{lenses.map((entry) => (
						<li key={entry.lensId} className="flex items-start gap-4 border-b px-1 py-4">
							<span className="flex w-24 shrink-0 items-center gap-1.5">
								<span
									aria-hidden
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										VERDICT_DOT[entry.verdict as LensVerdict] ?? VERDICT_DOT.pending,
									)}
								/>
								<span
									className={cn(
										"truncate rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
										VERDICT_TONE[entry.verdict as LensVerdict] ?? VERDICT_TONE.pending,
									)}
								>
									{VERDICT_LABEL[entry.verdict as LensVerdict] ?? entry.verdict}
								</span>
							</span>
							<span className="w-40 shrink-0">
								<span className="block text-sm text-foreground">{lensCopy(entry).name}</span>
								<span className="block font-mono text-xs text-muted-foreground tabular-nums">
									{entry.elapsedSeconds === null
										? "queued"
										: `${entry.elapsedSeconds.toFixed(1)}s · ${entry.toolCount} tools`}
								</span>
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								{entry.claim ? (
									<p
										className={cn(
											"text-sm",
											entry.verdict === "ruled_out" || entry.verdict === "rejected"
												? "text-muted-foreground line-through"
												: "text-foreground",
										)}
									>
										{entry.claim}
									</p>
								) : (
									<p className="text-sm text-muted-foreground/70">
										{entry.progressNote ?? "No candidate yet"}
									</p>
								)}
								{entry.reason ? (
									<p className="text-sm leading-6 text-muted-foreground">
										<span className="text-foreground">Validator:</span> {entry.reason}
									</p>
								) : null}
							</div>
							<span className="w-20 shrink-0 text-right">
								<ConfidenceMeter confidence={entry.confidence} />
							</span>
						</li>
					))}
				</ul>
			</section>
		</div>
	)
}

const summarise = (tally: ReturnType<typeof lensTally>): string => {
	const parts = [`${tally.total} lenses dispatched`]
	if (tally.promoted > 0) parts.push(`${tally.promoted} promoted`)
	if (tally.merged > 0) parts.push(`${tally.merged} merged`)
	if (tally.ruledOut > 0) parts.push(`${tally.ruledOut} ruled out`)
	if (tally.rejected > 0) parts.push(`${tally.rejected} rejected`)
	if (parts.length === 1) parts.push(`${tally.reported} reported`)
	return parts.join(" · ")
}
