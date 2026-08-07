import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueEscalationAttemptDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"

import { ChecksRail } from "./checks-rail"
import { fanoutRunSteps } from "./lens-derive"
import { splitDuration } from "./investigation-display"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { investigationOriginLabel } from "./investigation-status"

/**
 * The evidence and the record, in that order.
 *
 * Checks lead, because "3 of 5 held" is the fastest read of whether the verdict
 * deserves trust — the full findings are a tab away, this is the summary. Below
 * it, the run as the sequence it actually was, then what the investigation points
 * at, then what it cost.
 *
 * The Actions group that used to sit at the top is gone: Resolve / Retry moved to
 * the page header, beside the subject they act on.
 */
export function InvestigationRail({ investigation }: { investigation: V2Investigation }) {
	const { snapshot, subject } = investigation
	const issueId = subject.type === "incident" ? subject.issue_id : null

	return (
		// `RightPanel` supplies no padding of its own — the old rail got its gutters
		// from `DetailRail.Group`'s `p-4`, and dropping that component dropped them
		// too, so the checks sat flush against the window edge.
		<div className="flex min-h-full flex-col gap-6 p-4">
			<ChecksRail investigation={investigation} />

			<section className="flex flex-col gap-3.5">
				<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
					Run
				</h3>
				{issueId ? (
					<EscalatedRunSpine investigation={investigation} issueId={issueId} />
				) : (
					<RunSpine investigation={investigation} attempt={null} />
				)}
			</section>

			<section className="flex flex-col gap-3 border-t pt-5.5">
				<h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
					Linked
				</h3>
				<LinkedRow label="Origin">
					<span className="text-foreground">
						{investigationOriginLabel(investigation.seeded_by)}
					</span>
				</LinkedRow>
				{issueId ? (
					<LinkedRow label="Issue">
						<Link
							to="/errors/issues/$issueId"
							params={{ issueId }}
							title={issueId}
							className="block truncate font-mono text-primary hover:underline"
						>
							{issueId}
						</Link>
					</LinkedRow>
				) : null}
				{subject.type === "incident" ? (
					<LinkedRow label="Incident">
						<code
							title={subject.incident_id}
							className="block truncate font-mono text-foreground"
						>
							{subject.incident_id}
						</code>
					</LinkedRow>
				) : null}
				{snapshot.references.map((reference) => (
					<LinkedRow key={reference.url} label={reference.label}>
						<ReferenceLink label={reference.label} url={reference.url} />
					</LinkedRow>
				))}
			</section>

			<Provenance investigation={investigation} />
		</div>
	)
}

function LinkedRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline gap-2 text-xs">
			<span className="w-16 shrink-0 truncate text-muted-foreground" title={label}>
				{label}
			</span>
			<span className="min-w-0 flex-1">{children}</span>
		</div>
	)
}

/**
 * Model and token spend, and who opened this. Deliberately the last thing in the
 * rail and deliberately quiet — it qualifies the verdict without competing with
 * it, but a diagnosis with no cost attached is an unaudited one.
 */
function Provenance({ investigation }: { investigation: V2Investigation }) {
	const { model, input_tokens: input, output_tokens: output } = investigation
	const tokens =
		input === null && output === null
			? null
			: `${input === null ? "—" : formatNumber(input)} in · ${output === null ? "—" : formatNumber(output)} out`

	return (
		<div className="mt-auto flex flex-col gap-1 border-t pt-5 text-[11px] text-muted-foreground">
			{model || tokens ? (
				<p className="break-words">{[model, tokens].filter(Boolean).join(" · ")}</p>
			) : null}
			<p>
				{investigation.seeded_by === "system"
					? "Opened automatically by Maple"
					: "Opened by a member of your team"}
			</p>
		</div>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Run spine
 * -----------------------------------------------------------------------------------------------*/

interface SpineNode {
	key: string
	label: string
	/** Instant to stamp the node with, when the event has one. */
	at?: string
	dot: string
	/** Elapsed time to the *next* node, rendered on the connector below this one. */
	gap?: string
	detail?: ReactNode
}

const STEP_DOT: Record<string, string> = {
	muted: "bg-muted-foreground/50",
	active: "bg-primary animate-pulse",
	success: "bg-success",
	failed: "bg-destructive",
}

/**
 * The diagnostic pass as the sequence it actually is. The elapsed time sits on
 * the connector between Opened and Diagnosed rather than in a stat row, because
 * that is what it is — the gap between two events.
 *
 * The middle of the spine (dispatch → report → validate) comes from
 * `placeholderRunSteps` and is the only invented part; the endpoints are real
 * timestamps. Escalation is the spine's terminal event rather than a separate
 * card: it is the last thing that happened in the same run.
 */
function RunSpine({
	investigation,
	attempt,
}: {
	investigation: V2Investigation
	attempt: IssueEscalationAttemptDocument | null
}) {
	const nodes: SpineNode[] = []

	const openedMs = toEpochMs(investigation.created_at)
	const diagnosedMs = investigation.diagnosed_at ? toEpochMs(investigation.diagnosed_at) : null
	// `splitDuration`, not `formatDuration`: this is the same time-to-diagnosis the
	// verdict card states one panel to the left, and the two read as different
	// numbers when one says "1.0min" and the other "1:00 min".
	const toDiagnosis =
		diagnosedMs !== null && Number.isFinite(openedMs) && diagnosedMs >= openedMs
			? splitDuration(diagnosedMs - openedMs)
			: null
	const elapsed = toDiagnosis ? `${toDiagnosis.value} ${toDiagnosis.unit}` : null

	nodes.push({
		key: "opened",
		label: "Opened",
		at: investigation.created_at,
		dot: "bg-muted-foreground/50",
		detail: (
			<p className="mt-0.5 text-[11px] text-muted-foreground">
				{investigationOriginLabel(investigation.seeded_by)} ·{" "}
				{investigation.subject.type === "freeform"
					? "question"
					: `${investigation.subject.incident_kind} incident`}
			</p>
		),
	})

	for (const step of fanoutRunSteps(investigation)) {
		nodes.push({
			key: step.key,
			label: step.label,
			dot: STEP_DOT[step.tone] ?? "bg-muted-foreground/50",
			detail: <p className="mt-0.5 text-[11px] text-muted-foreground">{step.detail}</p>,
		})
	}

	if (investigation.status === "investigating" && nodes.length === 1) {
		nodes.push({ key: "investigating", label: "Investigating…", dot: "bg-primary animate-pulse" })
	}

	if (investigation.diagnosed_at) {
		nodes.push({
			key: "diagnosed",
			label: "Diagnosed",
			at: investigation.diagnosed_at,
			dot: "bg-success",
			...(elapsed ? { gap: elapsed } : {}),
		})
	}

	if (attempt) {
		nodes.push({
			key: "escalation",
			label: ESCALATION_LABEL[attempt.status],
			...(attempt.processedAt ? { at: attempt.processedAt } : {}),
			dot: attempt.status === "failed" ? "bg-destructive" : "bg-muted-foreground/50",
			detail: <EscalationDetail attempt={attempt} />,
		})
	}

	if (investigation.status === "failed") {
		nodes.push({
			key: "failed",
			label: "Pass failed",
			at: investigation.updated_at,
			dot: "bg-destructive",
			detail: investigation.error ? (
				<p className="mt-1 break-words text-[11px] text-destructive">{investigation.error}</p>
			) : (
				<p className="mt-1 text-[11px] text-muted-foreground">
					No failure reason was recorded. Retry to run the pass again.
				</p>
			),
		})
	}

	if (investigation.status === "resolved") {
		nodes.push({
			key: "resolved",
			label: "Resolved",
			at: investigation.updated_at,
			dot: "bg-muted-foreground/30",
		})
	}

	return (
		<ol className="flex flex-col">
			{nodes.map((node, index) => {
				const isLast = index === nodes.length - 1
				return (
					<li key={node.key} className={cn("relative flex gap-3", isLast ? "pb-0" : "pb-4")}>
						{isLast ? null : (
							<span
								className="absolute bottom-0 left-[3px] top-3.5 w-px bg-border"
								aria-hidden
							/>
						)}
						<span
							className={cn("mt-[7px] size-[7px] shrink-0 rounded-full", node.dot)}
							aria-hidden
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline justify-between gap-2">
								<span className="truncate text-xs text-foreground">{node.label}</span>
								{node.at ? (
									<time
										dateTime={node.at}
										title={new Date(toEpochMs(node.at)).toLocaleString()}
										className="shrink-0 font-mono text-[11px] text-muted-foreground"
									>
										{formatRelativeTime(node.at)}
									</time>
								) : null}
							</div>
							{node.detail}
							{node.gap ? (
								<p className="mt-1 leading-none">
									<span className="font-mono text-xs font-medium text-foreground">
										{node.gap}
									</span>{" "}
									<span className="text-[11px] text-muted-foreground">to diagnosis</span>
								</p>
							) : null}
						</div>
					</li>
				)
			})}
		</ol>
	)
}

const ESCALATION_LABEL: Record<IssueEscalationAttemptDocument["status"], string> = {
	queued: "Escalation queued",
	sent: "Escalated",
	skipped: "Escalation skipped",
	failed: "Escalation failed",
}

const DELIVERY_TONE: Record<string, string> = {
	delivered: "text-success",
	failed: "text-destructive",
	disabled: "text-muted-foreground",
	missing: "text-muted-foreground",
}

function EscalationDetail({ attempt }: { attempt: IssueEscalationAttemptDocument }) {
	return (
		<div className="mt-1.5 flex flex-col gap-1">
			{attempt.deliveries.map((delivery) => (
				<div key={delivery.destinationId} className="flex flex-col">
					<div className="flex items-baseline justify-between gap-2 text-[11px]">
						<span className="min-w-0 truncate text-muted-foreground">
							{delivery.destinationName ?? delivery.destinationId}
						</span>
						<span className={cn("shrink-0", DELIVERY_TONE[delivery.status])}>
							{delivery.status}
						</span>
					</div>
					{delivery.error ? (
						<p className="break-words text-[11px] text-destructive/80">{delivery.error}</p>
					) : null}
				</div>
			))}
			<p className="text-[11px] text-muted-foreground">
				{attempt.attempts} attempt{attempt.attempts === 1 ? "" : "s"}
				{attempt.skipReason ? ` · ${attempt.skipReason.replaceAll("_", " ")}` : ""}
			</p>
		</div>
	)
}

/**
 * The escalation attempt is a separate request, so the spine renders without it
 * and gains its terminal node when the query lands — `orElse` returns the spine
 * rather than null, or the whole run history would blank while one optional
 * lookup is in flight.
 */
function EscalatedRunSpine({
	investigation,
	issueId,
}: {
	investigation: V2Investigation
	issueId: NonNullable<Extract<V2Investigation["subject"], { type: "incident" }>["issue_id"]>
}) {
	const result = useAtomValue(
		MapleApiAtomClient.query("errors", "listIssueEscalations", {
			params: { issueId },
			reactivityKeys: [`errorIssue:${issueId}:escalations`],
		}),
	)
	return Result.builder(result)
		.onSuccess((response) => (
			<RunSpine
				investigation={investigation}
				attempt={
					response.attempts.find((candidate) => candidate.investigationId === investigation.id) ??
					null
				}
			/>
		))
		.orElse(() => <RunSpine investigation={investigation} attempt={null} />)
}

/**
 * Snapshot references are app-relative paths written by the API, so they route
 * through the SPA. An absolute URL leaves the app and gets a plain anchor.
 */
function ReferenceLink({ label, url }: { label: string; url: string }) {
	if (!url.startsWith("/")) {
		return (
			<a
				href={url}
				rel="noreferrer"
				className="block truncate text-primary hover:underline"
				target="_blank"
			>
				{label}
			</a>
		)
	}
	return (
		<Link to={url} className="block truncate text-primary hover:underline">
			{label}
		</Link>
	)
}
