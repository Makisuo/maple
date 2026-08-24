import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { Schema } from "effect"

import type { AiSessionSpan } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { ChatBubbleSparkleIcon } from "@/components/icons"
import { CopyableValue } from "@/components/attributes"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NotFoundError } from "@/components/route-error"
import { QueryErrorState } from "@/components/common/query-error-state"
import {
	isSessionView,
	SessionViews,
	type SessionView,
} from "@/components/agent-sessions/session-detail/session-views"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import {
	breadcrumbSessionId,
	buildBackToSessionsHref,
	resolveWindow,
} from "@/lib/agent-sessions/session-window"
import { buildSessionSummary, type SessionSummary } from "@/lib/agent-sessions/session-summary"
import { buildSessionTurns } from "@/lib/agent-sessions/session-turns"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { displayError } from "@/lib/error-messages"
import { aiSessionSpansResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

const agentSessionSearchSchema = Schema.Struct({
	// Warehouse timestamps: the session's first and last span, carried in from
	// the list row or — for a link that arrived without them — written back here
	// once the read resolved the session. They bound the warehouse read, which is
	// what makes it cheap; without them it finds the session by id across
	// retention instead, which is why the page bothers to stamp them.
	t: Schema.optional(Schema.String),
	end: Schema.optional(Schema.String),
	// Which of the three views is open. A search param rather than a route
	// segment on purpose: Back from the detail page returns to the list the
	// reader came from, not to the view they looked at before this one.
	view: Schema.optional(Schema.String),
	// The span expanded inline (Trace) or open in the docked drawer (Flow). In
	// the URL rather than component state so a pasted link reopens the exact
	// span someone was looking at, in either debug view.
	span: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())),
})

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
	// `undefined` spreads to nothing, which is exactly the request the endpoint
	// reads as "resolve this session from its id".
	const result = useAtomValue(aiSessionSpansResultAtom({ data: { sessionId, ...queryWindow } }))

	return Result.builder(result)
		.onInitial(() => (
			<SessionShell sessionId={sessionId}>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<Skeleton className="h-9 w-80" />
					</DashboardLayout.Sticky>
					<DashboardLayout.Fill>
						{/* The Overview's own shape — switcher, verdict, vitals, time bar —
						    so the page doesn't reflow on resolve. */}
						<div className="space-y-6 p-4">
							<Skeleton className="h-8 w-72" />
							<div className="flex flex-wrap items-start justify-between gap-8">
								<div className="space-y-3">
									<Skeleton className="h-9 w-[26rem] max-w-full" />
									<Skeleton className="h-4 w-80 max-w-full" />
								</div>
								<div className="flex gap-6">
									{Array.from({ length: 3 }).map((_, index) => (
										<Skeleton key={index} className="h-16 w-32" />
									))}
								</div>
							</div>
							<Skeleton className="h-4 w-full rounded-sm" />
							<div className="space-y-2">
								{Array.from({ length: 8 }).map((_, index) => (
									<Skeleton key={index} className="h-12 w-full" />
								))}
							</div>
						</div>
					</DashboardLayout.Fill>
				</DashboardLayout.Content>
			</SessionShell>
		))
		.onError((error) => (
			<SessionShell sessionId={sessionId}>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={breadcrumbSessionId(sessionId)} />
					</DashboardLayout.Sticky>
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
				</DashboardLayout.Content>
			</SessionShell>
		))
		.onSuccess((value) =>
			value.data.length === 0 ? (
				<SessionShell sessionId={sessionId}>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title={breadcrumbSessionId(sessionId)} />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<EmptySession sessionId={sessionId} windowed={queryWindow !== undefined} />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</SessionShell>
			) : (
				<SessionDetailBody sessionId={sessionId} spans={value.data} truncated={value.truncated} />
			),
		)
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
	const turns = useMemo(() => buildSessionTurns(spans), [spans])
	const summary = useMemo(() => buildSessionSummary({ spans, turns }), [spans, turns])

	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	// An unknown or absent `?view=` reads as the default rather than as an error:
	// the param is a hint from a link, and a mistyped one should still land the
	// reader on a page.
	const view: SessionView =
		search.view !== undefined && isSessionView(search.view) ? search.view : "overview"

	const changeView = useCallback(
		(next: SessionView) => {
			navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, view: next }) })
		},
		[navigate],
	)

	// A link that arrived without hints cost the warehouse a session lookup across
	// retention; stamping the bounds it found into the URL means this link never
	// pays for that again — a reload, a share, a bookmark all take the pruned
	// read. The exact bounds go in, unpadded: `resolveWindow` pads on the way out,
	// and padding here would compound on every write.
	//
	// An effect for the same reason `useCheckoutReturn` uses one: the URL is
	// external state being reconciled after an async result landed, which is not
	// something render can derive. `search.t` is both the guard and the result, so
	// it runs once and the re-render it causes is a no-op.
	//
	// A session still being written gets the bounds it had at read time, exactly
	// as a link from the list page does — the padding `resolveWindow` adds is the
	// only slack either one has.
	useEffect(() => {
		if (search.t !== undefined) return
		navigate({
			replace: true,
			search: (prev: Record<string, unknown>) => ({
				...prev,
				t: formatWarehouseDateTime(summary.startMs),
				end: formatWarehouseDateTime(summary.endMs),
			}),
		})
	}, [navigate, search.t, summary.startMs, summary.endMs])

	const selectSpan = useCallback(
		(spanId: string | undefined) => {
			navigate({
				search: (prev: Record<string, unknown>) => ({ ...prev, span: spanId }),
				// Expanding a span is a step the reader may want Back to undo;
				// moving the expansion, or collapsing it, is not.
				replace: search.span !== undefined,
			})
		},
		[navigate, search.span],
	)

	// Message content is opt-in and off by default, so most sessions have no
	// opening user message to title the page with.
	const title = summary.title ?? breadcrumbSessionId(sessionId)

	return (
		<SessionShell sessionId={sessionId}>
			<DashboardLayout.Content>
				<DashboardLayout.Sticky>
					<DashboardLayout.Header
						titleContent={
							<div className="flex min-w-0 items-center gap-2">
								<DashboardLayout.Title title={title}>
									{summary.title === undefined ? (
										// The id fallback title copies the full session id.
										<CopyableValue value={sessionId} label="Session ID">
											{title}
										</CopyableValue>
									) : (
										title
									)}
								</DashboardLayout.Title>
								{summary.failed && <Badge variant="error">Failed</Badge>}
								{summary.title !== undefined && (
									<CopyableValue
										value={sessionId}
										label="Session ID"
										className="shrink-0 font-mono font-normal text-muted-foreground text-xs"
									>
										{breadcrumbSessionId(sessionId)}
									</CopyableValue>
								)}
							</div>
						}
						description={sessionSubtitle(summary)}
					/>
				</DashboardLayout.Sticky>
				{/* `py-0` (the content blocks carry the padding instead) so the views'
				    sticky elements pin flush to the scroller's edges — sticky offsets
				    resolve against the padding edge. The top edge is the control bar;
				    the bottom is the Flow view's floor, whose docked span drawer
				    otherwise floats a padding's height short of the viewport with the
				    canvas scrolling visibly beneath it. */}
				<DashboardLayout.Scroll className="py-0">
					{truncated && (
						<div className="shrink-0 py-4">
							<Alert variant="warning">
								<AlertDescription>
									This session has more spans than one response carries — everything after
									the {summary.spanCount.toLocaleString()} spans below is missing, so the
									totals and the waterfall both stop early.
								</AlertDescription>
							</Alert>
						</div>
					)}
					{/* Content-driven height inside the scroller: `shrink-0` because a
					    scroll container's flex items shrink to fit before they overflow,
					    which would collapse the views instead of scrolling them; `grow`
					    (basis auto, not `flex-1`'s basis 0) so short content still fills
					    the viewport; the floor keeps the empty states from a sliver. */}
					<div className="flex min-h-64 shrink-0 grow flex-col">
						<SessionViews
							view={view}
							onViewChange={changeView}
							turns={turns}
							summary={summary}
							selectedSpanId={search.span}
							onSelectSpan={selectSpan}
						/>
					</div>
				</DashboardLayout.Scroll>
			</DashboardLayout.Content>
			{/* No side panel at any width: span detail expands inline under its
			    waterfall row, or in the Flow view's docked drawer. */}
		</SessionShell>
	)
}

/** Root, breadcrumbs, and the body row every branch fills with a `Content` column. */
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
			<DashboardLayout.Body>{children}</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function EmptySession({ sessionId, windowed }: { sessionId: string; windowed: boolean }) {
	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ChatBubbleSparkleIcon />
				</EmptyMedia>
				<EmptyTitle>No spans for this session</EmptyTitle>
				{/* Two genuinely different failures. With a window the read was
				    bounded by the link's own timestamps, so a stale or hand-edited
				    link can miss a session that exists; without one the search
				    already covered everything still retained, and promising a wider
				    range would be a lie. */}
				<EmptyDescription>
					Nothing was found for <span className="font-mono">{sessionId}</span>
					{windowed
						? " around the time this link points at. Open it from the Agent Sessions list to search again."
						: " in any retained trace — the session may be older than the trace retention."}
				</EmptyDescription>
			</EmptyHeader>
			<Button variant="outline" size="sm" render={<Link to="/agent-sessions" />}>
				Back to agent sessions
			</Button>
		</Empty>
	)
}

/** The identifying facts the list row carried and this page had dropped. The
 *  trace count is not one of them — the views below count what they draw. */
function sessionSubtitle(summary: SessionSummary): string {
	return [primaryVendorLabel(summary.vendorIds), formatRelativeTimeOrDate(summary.startMs)].join(" · ")
}

function primaryVendorLabel(vendorIds: readonly string[]): string {
	const vendorId = vendorIds[0]
	return vendorId === undefined ? "Agent session" : vendorLabel(vendorId)
}
