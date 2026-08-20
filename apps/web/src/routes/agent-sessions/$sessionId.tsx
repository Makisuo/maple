import { useMemo, type ReactNode } from "react"
import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Schema } from "effect"

import type { AiSessionSpan } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { ChatBubbleSparkleIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NotFoundError } from "@/components/route-error"
import { QueryErrorState } from "@/components/common/query-error-state"
import { vendorLabel } from "@/components/agent-sessions/agent-sessions-list"
import { SessionHeader } from "@/components/agent-sessions/session-detail/session-header"
import { SessionViews } from "@/components/agent-sessions/session-detail/session-views"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { buildSessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { displayError } from "@/lib/error-messages"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { aiSessionSpansResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

const agentSessionSearchSchema = Schema.Struct({
	// Warehouse timestamps carried in from the list row: the session's first and
	// last span. They bound the warehouse read, which is what makes it cheap —
	// without them the query scans every retained partition.
	t: Schema.optional(Schema.String),
	end: Schema.optional(Schema.String),
})

// Padding around the session's own window, so a session that straddles the list
// page's range edge still arrives whole. It is asymmetric because the hint is:
// the list clamps a row's start to the list's own window, so a session that began
// before the visible range reports its start as the range edge and reading from
// there alone silently drops its opening turns. The end needs no such allowance —
// a session running past the range edge is still running now.
const WINDOW_START_PADDING_MS = 24 * 60 * 60 * 1000
const WINDOW_END_PADDING_MS = 60 * 60 * 1000

/** Deep link with no hints: look back far enough to find most sessions, and
 *  accept the slower read that comes with it. */
const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const SESSION_TOO_LARGE_TAG = "@maple/http/ai-sessions/AiSessionTooLargeError"

export const Route = createFileRoute("/agent-sessions/$sessionId")({
	component: AgentSessionDetailPage,
	validateSearch: Schema.toStandardSchemaV1(agentSessionSearchSchema),
})

/**
 * Behind the `agent_tracing` org rollout flag, gated the same way the list page
 * is: in the component rather than `beforeLoad` (router context carries no
 * flags), `isLoaded` first so an entitled org gets no not-found flash, and no
 * route `loader` — a loader would fire the warehouse read for orgs that are not
 * entitled to see the page at all.
 */
function AgentSessionDetailPage() {
	const { flags, isLoaded } = useOrganizationFeatureFlags()
	if (!isLoaded) return null
	if (!flags.agentTracing) return <NotFoundError />
	return <AgentSessionDetailContent />
}

function AgentSessionDetailContent() {
	const { sessionId } = Route.useParams()
	const search = Route.useSearch()
	const queryWindow = useMemo(() => resolveWindow(search.t, search.end), [search.t, search.end])
	const result = useAtomValue(aiSessionSpansResultAtom({ data: { sessionId, ...queryWindow } }))

	return Result.builder(result)
		.onInitial(() => (
			<SessionShell sessionId={sessionId}>
				<DashboardLayout.Sticky>
					<Skeleton className="h-7 w-80" />
					<Skeleton className="h-10 w-56" />
					<Skeleton className="h-2.5 w-full rounded-full" />
					<div className="grid grid-cols-2 gap-4 md:grid-cols-5">
						{Array.from({ length: 5 }).map((_, index) => (
							<Skeleton key={index} className="h-20" />
						))}
					</div>
				</DashboardLayout.Sticky>
				<DashboardLayout.Fill>
					<div className="space-y-1 px-4">
						{Array.from({ length: 12 }).map((_, index) => (
							<Skeleton key={index} className="h-6 w-full" />
						))}
					</div>
				</DashboardLayout.Fill>
			</SessionShell>
		))
		.onError((error) => (
			<SessionShell sessionId={sessionId}>
				<DashboardLayout.Scroll>
					<QueryErrorState
						error={error}
						// The 413 describes itself precisely ("Session is too large to
						// load"); overriding it would replace a specific, actionable
						// message with a generic one.
						titleOverride={
							displayError(error)._tag === SESSION_TOO_LARGE_TAG
								? undefined
								: "Failed to load this agent session"
						}
					/>
				</DashboardLayout.Scroll>
			</SessionShell>
		))
		.onSuccess((value) => (
			<SessionShell sessionId={sessionId}>
				{value.data.length === 0 ? (
					<DashboardLayout.Scroll>
						<EmptySession sessionId={sessionId} />
					</DashboardLayout.Scroll>
				) : (
					<SessionDetailBody sessionId={sessionId} spans={value.data} truncated={value.truncated} />
				)}
			</SessionShell>
		))
		.render()
}

function SessionDetailBody({
	sessionId,
	spans,
	truncated,
}: {
	sessionId: string
	spans: readonly AiSessionSpan[]
	truncated: boolean
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const turns = useMemo(() => buildSessionTurns(spans), [spans])
	const summary = useMemo(() => buildSessionSummary(spans, turns, Date.now()), [spans, turns])

	// Message content is opt-in and off by default, so most sessions have no
	// opening user message to title the page with. Naming the agent and when it
	// ran is the next most identifying thing about it.
	const fallbackTitle = `${summary.agentNames[0] ?? primaryVendorLabel(summary.vendorIds)} · ${formatTimestampInTimezone(summary.startMs, { timeZone: effectiveTimezone })}`

	return (
		<>
			<DashboardLayout.Sticky>
				<SessionHeader summary={summary} sessionId={sessionId} fallbackTitle={fallbackTitle} />
				{truncated && (
					<p className="rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
						This session has more spans than one response carries — everything after the{" "}
						{summary.spanCount.toLocaleString()} spans below is missing, so the totals and the
						waterfall both stop early.
					</p>
				)}
			</DashboardLayout.Sticky>
			<DashboardLayout.Fill>
				{/* A floor rather than `min-h-0`: the header above is a sticky sibling
				    that cannot shrink, so on a short window this pane is what gives way,
				    and at zero the tabs and the waterfall are gone rather than scrolled.
				    16rem still lets the pane shrink far below its content — the waterfall
				    owns its own scrolling. */}
				<div className="flex min-h-64 flex-1 flex-col px-4 pb-2">
					<SessionViews turns={turns} summary={summary} />
				</div>
			</DashboardLayout.Fill>
		</>
	)
}

function SessionShell({ sessionId, children }: { sessionId: string; children: ReactNode }) {
	const searchStr = useRouterState({ select: (state) => state.location.searchStr })

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[
					{ label: "Agent Sessions", href: buildBackToSessionsHref(searchStr) },
					{ label: breadcrumbSessionId(sessionId) },
				]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>{children}</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function EmptySession({ sessionId }: { sessionId: string }) {
	return (
		<div className="flex flex-col items-center justify-center rounded-xl border border-border border-dashed px-6 py-20 text-center">
			<div className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
				<ChatBubbleSparkleIcon className="size-6" />
			</div>
			<p className="font-medium text-sm">No spans for this session</p>
			<p className="mt-1.5 max-w-md text-muted-foreground text-sm">
				Nothing was found for <span className="font-mono">{sessionId}</span> in this time range. Open
				it from the Agent Sessions list, or widen the range there first.
			</p>
		</div>
	)
}

/** Everything but this page's own params, so Back lands on the list the reader
 *  left — same time range, same filters. Mirrors `buildBackToTracesHref` in
 *  traces/$traceId, including reading the raw `searchStr`: the list owns its
 *  search schema, and re-encoding it through this route's would drop it. */
function buildBackToSessionsHref(searchStr: string): string {
	const params = new URLSearchParams(searchStr)
	params.delete("t")
	params.delete("end")
	const nextSearch = params.toString()
	return nextSearch ? `/agent-sessions?${nextSearch}` : "/agent-sessions"
}

/** Session ids belong to the framework that wrote them, and the long ones carry
 *  their entropy at both ends — `slice(0, 8)` of a `wrun_01KZ…` id renders the
 *  word "wrun_01K", which identifies nothing. */
const BREADCRUMB_ID_MAX_CHARS = 24

function breadcrumbSessionId(sessionId: string): string {
	if (sessionId.length <= BREADCRUMB_ID_MAX_CHARS) return sessionId
	return `${sessionId.slice(0, 9)}…${sessionId.slice(-4)}`
}

function primaryVendorLabel(vendorIds: readonly string[]): string {
	const vendorId = vendorIds[0]
	return vendorId === undefined ? "Agent session" : vendorLabel(vendorId)
}

function resolveWindow(t: string | undefined, end: string | undefined) {
	const startHint = t === undefined ? Number.NaN : toEpochMs(t)
	// A link that carries only `t` (copied from a trace, say) still narrows the
	// read: the session started there, so pad around that instant alone.
	const endHint = end === undefined ? startHint : toEpochMs(end)

	if (Number.isNaN(startHint) || Number.isNaN(endHint)) {
		const now = Date.now()
		return {
			startTime: formatWarehouseDateTime(now - FALLBACK_WINDOW_MS),
			endTime: formatWarehouseDateTime(now),
		}
	}

	return {
		startTime: formatWarehouseDateTime(startHint - WINDOW_START_PADDING_MS),
		endTime: formatWarehouseDateTime(endHint + WINDOW_END_PADDING_MS),
	}
}
