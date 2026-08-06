import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { CheckIcon, XmarkIcon } from "@/components/icons"
import { type CheckState, checksHeld, lensChecks } from "./lens-derive"

/**
 * The rail's lead, and the first thing anyone reads on the page: one line per
 * dispatched lens, with a ✓ / ✗ / ○ and a terse result.
 *
 * A failed check is not a gap — "callee percentiles flat, healthy" is a finding,
 * and it is what rules the obvious alternative out. That is why the header counts
 * how many *held* rather than how many ran.
 */
export function ChecksRail({ investigation }: { investigation: V2Investigation }) {
	const checks = lensChecks(investigation.lens_runs)
	// A single-agent run has no lens results to summarise, so the rail leads with
	// the run spine instead of a panel of invented ticks.
	if (checks.length === 0) return null
	const held = checksHeld(checks)
	// "so far" is only honest while something is still running. A skipped check on
	// a dead pass is settled — it is never going to report. A `pending` check has
	// reported but is still being ranked, so the count is not final either.
	const pending = checks.filter(
		(check) => check.state === "checking" || check.state === "queued" || check.state === "pending",
	).length

	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-baseline gap-2">
				<h3 className="min-w-0 flex-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
					Checks
				</h3>
				<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
					{held} of {checks.length} {pending === 0 ? "held" : "so far"}
				</span>
			</div>
			<ul className="flex flex-col">
				{checks.map((check) => (
					<li key={check.key} className="flex items-start gap-2.5 border-b py-2.5 last:border-b-0">
						<span className="flex h-4 w-3 shrink-0 items-center justify-center">
							<CheckGlyph state={check.state} />
						</span>
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span
								className={cn(
									"text-xs",
									check.state === "held" ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{check.label}
							</span>
							<span
								className={cn(
									"text-[11px] leading-4",
									check.state === "checking" ? "text-primary" : "text-muted-foreground",
								)}
							>
								{check.result}
							</span>
						</span>
					</li>
				))}
			</ul>
		</section>
	)
}

function CheckGlyph({ state }: { state: CheckState }) {
	switch (state) {
		case "held":
			return <CheckIcon size={11} className="text-success" aria-label="Held" />
		case "failed":
			return <XmarkIcon size={10} className="text-muted-foreground" aria-label="Did not hold" />
		case "checking":
			return <span aria-label="Checking" className="size-1.5 animate-pulse rounded-full bg-primary" />
		case "pending":
			// Reported, not yet ranked. Deliberately neutral: a tick or a cross here
			// would state a verdict the validator has not reached.
			return (
				<span
					aria-label="Reported, awaiting the validator"
					className="size-1.5 rounded-full bg-muted-foreground/50"
				/>
			)
		default:
			return (
				<span
					aria-label={state === "skipped" ? "Skipped" : "Queued"}
					className="size-1.5 rounded-full border border-muted-foreground/40"
				/>
			)
	}
}
