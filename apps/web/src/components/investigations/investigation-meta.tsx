/**
 * What this investigation points at, and what it cost — one quiet strip along the
 * bottom of the page.
 *
 * This is what survived the right rail. The rail's lead was a checks panel that
 * the provenance canvas now says better (every lane is a node with its verdict
 * word, and the held count rides the column heading), and its run spine had
 * already gone for the same reason. What was left — the linked ids and the model
 * spend — did not justify a 320px column standing empty beside a canvas that
 * wanted the width.
 *
 * Bottom, not top: none of it is what you came to read. It is the audit trail
 * under the finding, and an unaudited diagnosis is the thing to avoid — not an
 * unread one.
 */
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueEscalationAttemptDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { investigationOriginLabel } from "./investigation-status"

export function InvestigationMeta({ investigation }: { investigation: V2Investigation }) {
	const { snapshot, subject } = investigation
	const issueId = subject.type === "incident" ? subject.issue_id : null

	return (
		<section className="flex shrink-0 flex-col gap-3 border-t pt-5">
			<h2 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				Linked
			</h2>
			{/*
			 * A wrapping row of labelled pairs rather than the rail's stacked list.
			 * The rail stacked them because it was 320px wide; across the full page a
			 * stack would be eight rows of two words each.
			 */}
			<div className="flex flex-wrap items-baseline gap-x-8 gap-y-2.5 text-xs">
				<Pair label="Origin">
					<span className="text-foreground">
						{investigationOriginLabel(investigation.seeded_by)}
					</span>
				</Pair>
				{issueId ? (
					<Pair label="Issue">
						<Link
							to="/errors/issues/$issueId"
							params={{ issueId }}
							title={issueId}
							className="max-w-60 truncate font-mono text-primary hover:underline"
						>
							{issueId}
						</Link>
					</Pair>
				) : null}
				{subject.type === "incident" ? (
					<Pair label="Incident">
						<code title={subject.incident_id} className="max-w-60 truncate font-mono">
							{subject.incident_id}
						</code>
					</Pair>
				) : null}
				{snapshot.references.map((reference) => (
					<Pair key={reference.url} label={reference.label}>
						<ReferenceLink label={reference.label} url={reference.url} />
					</Pair>
				))}
				{issueId ? <Escalation investigation={investigation} issueId={issueId} /> : null}
			</div>
			<Provenance investigation={investigation} />
		</section>
	)
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
	return (
		<span className="flex min-w-0 items-baseline gap-2">
			<span className="shrink-0 text-muted-foreground" title={label}>
				{label}
			</span>
			<span className="min-w-0 truncate text-foreground">{children}</span>
		</span>
	)
}

/**
 * Model and token spend, and who opened this. Deliberately the last thing on the
 * page and deliberately quiet — it qualifies the verdict without competing with
 * it, but a diagnosis with no cost attached is an unaudited one.
 */
function Provenance({ investigation }: { investigation: V2Investigation }) {
	const { model, input_tokens: input, output_tokens: output } = investigation
	const tokens =
		input === null && output === null
			? null
			: `${input === null ? "—" : formatNumber(input)} in · ${output === null ? "—" : formatNumber(output)} out`

	const opened =
		investigation.seeded_by === "system"
			? "Opened automatically by Maple"
			: "Opened by a member of your team"

	return (
		<p className="text-[11px] text-muted-foreground">
			{[model, tokens, opened].filter(Boolean).join(" · ")}
		</p>
	)
}

/**
 * Whether this run's diagnosis reached anyone.
 *
 * A separate request against a different API, so it renders nothing at all until
 * it lands — an optional lookup must never leave a "Loading…" pair sitting in a
 * row of resolved facts, and an investigation with no escalation is the common
 * case.
 */
function Escalation({
	investigation,
	issueId,
}: {
	investigation: V2Investigation
	issueId: NonNullable<Extract<V2Investigation["subject"], { type: "incident" }>["issue_id"]>
}) {
	const result = useAtomValue(
		retainedQuery("errors", "listIssueEscalations", {
			params: { issueId },
			reactivityKeys: [`errorIssue:${issueId}:escalations`],
		}),
	)
	return Result.builder(result)
		.onSuccess((response) => {
			const attempt = response.attempts.find(
				(candidate) => candidate.investigationId === investigation.id,
			)
			if (!attempt) return null
			const failed = attempt.deliveries.filter((delivery) => delivery.status === "failed").length
			return (
				<Pair label="Escalation">
					<span
						className={cn(attempt.status === "failed" ? "text-destructive" : "text-foreground")}
						title={attempt.deliveries
							.map(
								(delivery) =>
									`${delivery.destinationName ?? delivery.destinationId}: ${delivery.status}`,
							)
							.join("\n")}
					>
						{ESCALATION_LABEL[attempt.status]}
						{attempt.deliveries.length > 0
							? ` · ${attempt.deliveries.length} destination${attempt.deliveries.length === 1 ? "" : "s"}`
							: ""}
						{failed > 0 ? ` · ${failed} failed` : ""}
					</span>
				</Pair>
			)
		})
		.orElse(() => null)
}

const ESCALATION_LABEL: Record<IssueEscalationAttemptDocument["status"], string> = {
	queued: "Queued",
	sent: "Sent",
	skipped: "Skipped",
	failed: "Failed",
} satisfies Record<IssueEscalationAttemptDocument["status"], string>

/**
 * Snapshot references are app-relative paths written by the API, so they route
 * through the SPA. An absolute URL leaves the app and gets a plain anchor.
 */
function ReferenceLink({ label, url }: { label: string; url: string }) {
	if (!url.startsWith("/")) {
		return (
			<a href={url} rel="noreferrer" target="_blank" className="truncate text-primary hover:underline">
				{label}
			</a>
		)
	}
	return (
		<Link to={url} className="truncate text-primary hover:underline">
			{label}
		</Link>
	)
}
