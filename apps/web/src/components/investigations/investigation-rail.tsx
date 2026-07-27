import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { IssueEscalationAttemptDocument } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { formatDuration, formatNumber } from "@maple/ui/format"
import { formatRelativeTime, toEpochMs } from "@maple/ui/time-format"

import { DetailRail } from "@/components/common/detail-rail"
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/components/errors/severity-badge"
import { ConfidenceMeter } from "./confidence-meter"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { investigationOriginLabel } from "./investigation-status"

/**
 * What the transcript doesn't say. The transcript is the investigation's
 * argument; this rail is its record — who opened it, how long the pass took,
 * what it cost, what it points at, and whether anyone was told.
 *
 * Most of this was on the wire and rendered nowhere: `created_at`,
 * `diagnosed_at`, the token counts, `report.severityAssessment`, the incident
 * and issue IDs, and — worst — `error`, so a failed pass offered a Retry button
 * and never said what went wrong.
 */
export function InvestigationRail({
	investigation,
	busy,
	onResolve,
	onRestart,
}: {
	investigation: V2Investigation
	busy: boolean
	onResolve: () => void
	onRestart: () => void
}) {
	const { snapshot, subject, report } = investigation
	const isResolved = investigation.status === "resolved"
	const issueId = subject.type === "incident" ? subject.issue_id : null

	return (
		<div className="flex flex-col">
			<DetailRail.Group label="Actions">
				{isResolved || investigation.status === "failed" ? (
					<Button size="sm" className="w-full" onClick={onRestart} disabled={busy}>
						{isResolved ? "Reopen" : "Retry"}
					</Button>
				) : (
					<Button
						size="sm"
						variant="outline"
						className="w-full"
						onClick={onResolve}
						disabled={busy}
					>
						Resolve
					</Button>
				)}
			</DetailRail.Group>

			<DetailRail.Group label="Run">
				{issueId ? (
					<EscalatedRunSpine investigation={investigation} issueId={issueId} />
				) : (
					<RunSpine investigation={investigation} attempt={null} />
				)}
			</DetailRail.Group>

			{report ? (
				<DetailRail.Group label="Diagnosis">
					<DetailRail.Row label="Confidence">
						<ConfidenceMeter confidence={report.confidence} />
					</DetailRail.Row>
					<DetailRail.Row label="AI severity">
						<span
							className={cn(
								"rounded px-1.5 py-0.5 text-xs font-medium",
								SEVERITY_TONE[report.severityAssessment],
							)}
						>
							{SEVERITY_LABEL[report.severityAssessment]}
						</span>
					</DetailRail.Row>
					{investigation.model ? (
						<DetailRail.Row label="Model" title={investigation.model}>
							<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
								{investigation.model}
							</code>
						</DetailRail.Row>
					) : null}
					<TokenRow investigation={investigation} />
				</DetailRail.Group>
			) : null}

			<DetailRail.Group label="Subject">
				<DetailRail.Row label="Origin">
					<span className="text-sm text-foreground">
						{investigationOriginLabel(investigation.seeded_by)}
					</span>
				</DetailRail.Row>
				{subject.type === "incident" ? (
					<DetailRail.Row label="Incident" title={subject.incident_id}>
						<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
							{subject.incident_id}
						</code>
					</DetailRail.Row>
				) : null}
				{issueId ? (
					<DetailRail.Row label="Issue" title={issueId}>
						<Link
							to="/errors/issues/$issueId"
							params={{ issueId }}
							className="block max-w-full truncate font-mono text-xs text-primary hover:underline"
						>
							{issueId}
						</Link>
					</DetailRail.Row>
				) : null}
				{snapshot.references.length > 0 ? (
					<div className="mt-1 flex flex-col gap-1">
						{snapshot.references.map((reference) => (
							<ReferenceLink key={reference.url} label={reference.label} url={reference.url} />
						))}
					</div>
				) : null}
			</DetailRail.Group>
		</div>
	)
}

/** Both counts or neither — a lone number reads as a total and misleads. */
function TokenRow({ investigation }: { investigation: V2Investigation }) {
	const { input_tokens: input, output_tokens: output } = investigation
	if (input === null && output === null) return null
	return (
		<DetailRail.Row label="Tokens">
			<span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
				{input === null ? "—" : formatNumber(input)} in ·{" "}
				{output === null ? "—" : formatNumber(output)} out
			</span>
		</DetailRail.Row>
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

/**
 * The diagnostic pass as the sequence it actually is. The elapsed time sits on
 * the connector between Opened and Diagnosed rather than in a stat row, because
 * that is what it is — the gap between two events, not a standalone metric. It
 * is also the number the product is about, and until now nothing rendered it.
 *
 * Escalation is the spine's terminal event rather than a separate card: it is
 * the last thing that happened in the same run.
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
	const elapsed =
		diagnosedMs !== null && Number.isFinite(openedMs) && diagnosedMs >= openedMs
			? formatDuration(diagnosedMs - openedMs)
			: null

	nodes.push({
		key: "opened",
		label: "Opened",
		at: investigation.created_at,
		dot: "bg-muted-foreground/50",
		...(elapsed ? { gap: elapsed } : {}),
	})

	if (investigation.status === "investigating") {
		nodes.push({
			key: "investigating",
			label: "Investigating…",
			dot: "bg-primary animate-pulse",
		})
	}

	if (investigation.diagnosed_at) {
		nodes.push({
			key: "diagnosed",
			label: "Diagnosed",
			at: investigation.diagnosed_at,
			dot: "bg-success",
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
				<p className="mt-1 break-words text-xs text-destructive">{investigation.error}</p>
			) : (
				<p className="mt-1 text-xs text-muted-foreground">
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
					<li key={node.key} className={cn("relative flex gap-3", isLast ? "pb-0" : "pb-3")}>
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
				className="block truncate text-xs text-primary hover:underline"
				target="_blank"
			>
				{label}
			</a>
		)
	}
	return (
		<Link to={url} className="block truncate text-xs text-primary hover:underline">
			{label}
		</Link>
	)
}
