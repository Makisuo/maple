import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"

import { CauseRecap } from "./cause-recap"

/**
 * The findings that back the cause, promoted out of the chat transcript where
 * they used to live inside a card inside a scroll. Each finding is numbered and
 * carries its own citations — the trace chips are real links, which is the whole
 * reason to give evidence a tab of its own rather than a paragraph.
 */
export function EvidenceTab({ investigation }: { investigation: V2Investigation }) {
	const evidence = (investigation.report?.evidence ?? []).filter(
		(item) => item.note || item.traceIds.length > 0 || item.logPatterns.length > 0,
	)

	if (evidence.length === 0) {
		return (
			<div className="flex shrink-0 flex-col gap-6">
				<CauseRecap investigation={investigation} />
				<p className="py-10 text-center text-sm text-muted-foreground">
					{investigation.status === "investigating"
						? "Evidence appears here as the lenses report."
						: investigation.status === "inconclusive"
							? "This run promoted no cause, so it attached no evidence. What it did rule out is on the Overview."
							: "This pass recorded no evidence."}
				</p>
			</div>
		)
	}

	const traceCount = evidence.reduce((total, item) => total + item.traceIds.length, 0)

	return (
		<div className="flex shrink-0 flex-col gap-6">
			<CauseRecap investigation={investigation} />
			<section className="flex shrink-0 flex-col gap-3.5">
				<div className="flex items-baseline gap-2.5">
					<h2 className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
						Evidence
					</h2>
					<span className="text-sm text-muted-foreground">
						{evidence.length} {evidence.length === 1 ? "finding" : "findings"}
						{traceCount > 0 ? ` · ${traceCount} ${traceCount === 1 ? "trace" : "traces"}` : ""}
					</span>
				</div>
				<ol className="flex flex-col border-t">
					{evidence.map((item, index) => (
						<li
							key={`${index}:${item.note}`}
							className="flex items-start gap-4 border-b px-1 py-4"
						>
							<span className="mt-0.5 w-5.5 shrink-0 font-mono text-xs font-medium text-muted-foreground tabular-nums">
								{String(index + 1).padStart(2, "0")}
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-2">
								{item.note ? (
									<p className="text-sm leading-6 text-foreground">{item.note}</p>
								) : null}
								{item.traceIds.length > 0 || item.logPatterns.length > 0 ? (
									<div className="flex flex-wrap items-center gap-1.5">
										{item.traceIds.map((traceId) => (
											<Link
												key={traceId}
												to="/traces/$traceId"
												params={{ traceId }}
												title={traceId}
												className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-muted/70"
											>
												{traceId.slice(0, 12)}
												{traceId.length > 12 ? "…" : ""}
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
						</li>
					))}
				</ol>
			</section>
		</div>
	)
}
