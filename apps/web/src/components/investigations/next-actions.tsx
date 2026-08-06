import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"

/**
 * `report.suggestedActions` as a numbered ledger rather than a bulleted list —
 * they arrive ordered by expected impact and a list hides that, so the ordinal
 * is the point.
 *
 * Each row offers the one place the action is carried out. The API returns
 * prose, not structured actions, so the destination is inferred from the verb;
 * a row we can't route anywhere simply has no button rather than a dead one.
 */
export function NextActions({ investigation }: { investigation: V2Investigation }) {
	const actions = investigation.report?.suggestedActions ?? []
	if (actions.length === 0) return null

	return (
		<section className="flex shrink-0 flex-col gap-3.5">
			<div className="flex items-baseline gap-2.5">
				<h2 className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
					Next actions
				</h2>
				<span className="text-sm text-muted-foreground">ordered by expected impact</span>
			</div>
			<ol className="flex flex-col border-t">
				{actions.map((action, index) => (
					<li key={action} className="flex items-center gap-4 border-b px-1 py-3.5">
						<span className="w-5.5 shrink-0 font-mono text-xs font-medium text-muted-foreground tabular-nums">
							{String(index + 1).padStart(2, "0")}
						</span>
						<p className="min-w-0 flex-1 text-sm leading-6 text-foreground">{action}</p>
						<ActionTarget action={action} investigation={investigation} />
					</li>
				))}
			</ol>
		</section>
	)
}

/**
 * Best-effort routing from a sentence to a destination. Deliberately
 * conservative — the wrong link is worse than none, so anything that doesn't
 * match a clear verb gets an empty slot that still holds the column lane.
 */
function ActionTarget({ action, investigation }: { action: string; investigation: V2Investigation }) {
	const text = action.toLowerCase()
	const slot = "flex w-33 shrink-0 justify-end"

	if (text.includes("alert")) {
		return (
			<span className={slot}>
				<Button
					size="sm"
					variant="outline"
					className="h-6.5 px-2.5 text-xs"
					render={<Link to="/alerts" />}
				>
					Create alert
				</Button>
			</span>
		)
	}
	if (text.includes("dashboard")) {
		return (
			<span className={slot}>
				<Button
					size="sm"
					variant="outline"
					className="h-6.5 px-2.5 text-xs"
					render={<Link to="/dashboards" />}
				>
					Open dashboards
				</Button>
			</span>
		)
	}
	if (text.includes("trace") || text.includes("span")) {
		return (
			<span className={slot}>
				<Button
					size="sm"
					variant="outline"
					className="h-6.5 px-2.5 text-xs"
					render={<Link to="/traces" />}
				>
					View traces
				</Button>
			</span>
		)
	}
	if (text.includes("log")) {
		return (
			<span className={slot}>
				<Button
					size="sm"
					variant="outline"
					className="h-6.5 px-2.5 text-xs"
					render={<Link to="/logs" />}
				>
					Search logs
				</Button>
			</span>
		)
	}
	const issueId = investigation.subject.type === "incident" ? investigation.subject.issue_id : null
	if (issueId && (text.includes("issue") || text.includes("error"))) {
		return (
			<span className={slot}>
				<Button
					size="sm"
					variant="outline"
					className="h-6.5 px-2.5 text-xs"
					render={<Link to="/errors/issues/$issueId" params={{ issueId }} />}
				>
					Open issue
				</Button>
			</span>
		)
	}
	return <span className={slot} aria-hidden />
}
