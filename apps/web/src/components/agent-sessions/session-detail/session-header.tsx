import type { ReactNode } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { CopyableValue } from "@/components/attributes"
import { UserIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import type { SessionSummary } from "@/lib/agent-sessions/session-summary"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"

/**
 * The page's heading: what ran, when, on what — the facts a reader needs to
 * know which session this is before any view opens.
 *
 * The heading is the agent's name (or, unnamed, the framework's), never the
 * session id or the opening prompt: the id says nothing to a human, and the
 * first line of a prompt is usually a boilerplate instruction that reads as a
 * title the session doesn't deserve. Both stay on the page, each in its own
 * place — the prompt as a quoted line under the heading, the id as the last
 * fact, in full, one click from the clipboard.
 */
export function SessionHeader({
	sessionId,
	summary,
	turns,
}: {
	sessionId: string
	summary: SessionSummary
	turns: readonly SessionTurn[]
}) {
	const identity = sessionIdentity(summary)
	const VendorIcon = vendorIcon(summary.vendorIds[0] ?? "")
	const turnWord = turns[0]?.anchorKind === "trace" ? "segment" : "turn"

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex min-w-0 items-center gap-2">
				<VendorIcon size={18} className="shrink-0 text-muted-foreground" aria-hidden />
				<DashboardLayout.Title title={identity.heading}>{identity.heading}</DashboardLayout.Title>
				{summary.failed && <Badge variant="error">Failed</Badge>}
			</div>

			{summary.title !== undefined && (
				// Quoted and marked with the user glyph so it reads as what it is —
				// the first thing the user said — and not as a name for the session.
				<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
					<UserIcon size={13} className="shrink-0" aria-hidden />
					<span className="sr-only">Opening prompt:</span>
					<span className="min-w-0 truncate" title={summary.title}>
						“{summary.title}”
					</span>
				</p>
			)}

			<dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
				{identity.framework !== undefined && <Fact label="Framework">{identity.framework}</Fact>}
				<Fact label="Started" title={new Date(summary.startMs).toLocaleString()}>
					{formatRelativeTimeOrDate(summary.startMs)}
				</Fact>
				<Fact label="Duration">{formatSessionDuration(summary.wallClockMs)}</Fact>
				<Fact label={turns.length === 1 ? capitalize(turnWord) : `${capitalize(turnWord)}s`}>
					{turns.length}
				</Fact>
				{summary.models.length > 0 && (
					<Fact label="Model" title={summary.models.map((model) => model.model).join(", ")} mono>
						{firstPlusRest(summary.models.map((model) => shortTarget(model.model)))}
					</Fact>
				)}
				{summary.serviceNames.length > 0 && (
					<Fact label="Service" title={summary.serviceNames.join(", ")} mono>
						{firstPlusRest(summary.serviceNames)}
					</Fact>
				)}
				<Fact label="Session ID">
					<CopyableValue value={sessionId} label="Session ID" className="font-mono">
						{sessionId}
					</CopyableValue>
				</Fact>
			</dl>
		</div>
	)
}

/**
 * What to call the session. A named agent is the best name there is; without
 * one the framework stands in, and without even that the page says "Agent
 * session" rather than parroting an unidentified vendor id. The framework is
 * returned separately only when it is not already the heading.
 */
export function sessionIdentity(summary: Pick<SessionSummary, "agentNames" | "vendorIds">): {
	heading: string
	framework: string | undefined
} {
	const vendorId = summary.vendorIds[0]
	const framework = vendorId === undefined ? undefined : vendorLabel(vendorId)
	const agentName = summary.agentNames[0]
	if (agentName !== undefined) return { heading: agentName, framework }
	if (framework !== undefined && framework !== "Unidentified") {
		return { heading: `${framework} session`, framework: undefined }
	}
	return { heading: "Agent session", framework: undefined }
}

function Fact({
	label,
	title,
	mono,
	children,
}: {
	label: string
	title?: string
	mono?: boolean
	children: ReactNode
}) {
	return (
		<div className="flex min-w-0 max-w-full items-baseline gap-1.5" title={title}>
			<dt className="shrink-0 font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.08em]">
				{label}
			</dt>
			<dd className={mono ? "min-w-0 truncate font-mono" : "min-w-0 truncate"}>{children}</dd>
		</div>
	)
}

/** "claude-sonnet-5 +1": the first name, the rest as a count — the full list
 *  goes in the `title`. */
function firstPlusRest(names: readonly string[]): string {
	const [first, ...rest] = names
	if (first === undefined) return ""
	return rest.length > 0 ? `${first} +${rest.length}` : first
}

function capitalize(word: string): string {
	return word[0]!.toUpperCase() + word.slice(1)
}
