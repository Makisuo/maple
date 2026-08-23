import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { Schema } from "effect"

import type { AiSessionSpan } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { ChatBubbleSparkleIcon } from "@/components/icons"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { NotFoundError } from "@/components/route-error"
import { QueryErrorState } from "@/components/common/query-error-state"
import { SessionHeader } from "@/components/agent-sessions/session-detail/session-header"
import { SessionViews } from "@/components/agent-sessions/session-detail/session-views"
import type { TraceSelection } from "@/lib/agent-sessions/span-filters"
import { TraceSpanDetailPanel } from "@/components/traces/trace-span-detail-panel"
import { useAppHotkey } from "@/hooks/use-app-hotkey"
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
	// The in-page trace pane: the trace it shows and, optionally, the span it has
	// focused. In the URL rather than component state so a pane the reader opened
	// survives a reload and travels in a pasted link.
	//
	// Checked, not bare: the pane decodes this through the `TraceId` brand with
	// `decodeSync`, so a hand-edited `?trace=` or `?trace=%20` would throw during
	// render — past the pane's own error branch and into the router's error
	// component. Rejecting it here drops the param instead.
	trace: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())),
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
						<div className="space-y-4 p-4">
							<Skeleton className="h-8 w-44" />
							<Skeleton className="h-1.5 w-full rounded-full" />
							{/* The same container-query ladder `SessionHeader`'s stat band uses,
							    so the page doesn't reflow on resolve. */}
							<div className="@container grid grid-cols-1 gap-4 @2xl:grid-cols-2 @3xl:grid-cols-3 @4xl:grid-cols-5">
								{Array.from({ length: 5 }).map((_, index) => (
									<Skeleton key={index} className="h-20" />
								))}
							</div>
						</div>
						<div className="space-y-1 px-4">
							{Array.from({ length: 12 }).map((_, index) => (
								<Skeleton key={index} className="h-6 w-full" />
							))}
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

	// Memoized because `SessionViews` and the views below it key their own work on
	// this object.
	const selection: TraceSelection | undefined = useMemo(
		() => (search.trace === undefined ? undefined : { traceId: search.trace, spanId: search.span }),
		[search.trace, search.span],
	)

	const openTrace = useCallback(
		(target: TraceSelection) => {
			navigate({
				search: (prev: Record<string, unknown>) => ({
					...prev,
					trace: target.traceId,
					span: target.spanId,
				}),
				// Opening the pane is a step the reader may want Back to undo;
				// refocusing inside an open pane is not.
				replace: search.trace === target.traceId,
			})
		},
		[navigate, search.trace],
	)

	const closeTrace = useCallback(() => {
		navigate({
			search: (prev: Record<string, unknown>) => ({ ...prev, trace: undefined, span: undefined }),
			replace: true,
		})
	}, [navigate])

	// Esc closes the pane. The dialog guard defers to any sheet the panel opened,
	// so that closes first.
	useAppHotkey("list.clear", closeTrace, { enabled: selection !== undefined })

	// The pane's warehouse read needs a timestamp inside the trace to stay off the
	// full partition scan. Deliberately the trace's first span here rather than the
	// focused one: a per-span hint re-keys the pane's atom on every click inside
	// the same trace, re-running the hierarchy query against a shifted window.
	const paneTimestamp =
		selection === undefined
			? search.t
			: (spans.find((span) => span.traceId === selection.traceId)?.timestamp ?? search.t)

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
								<DashboardLayout.Title title={title}>{title}</DashboardLayout.Title>
								{summary.failed && <Badge variant="error">Failed</Badge>}
							</div>
						}
						description={sessionSubtitle(summary)}
					/>
				</DashboardLayout.Sticky>
				{/* `pt-0` (the stats block carries the padding instead) so the views'
				    sticky control bar pins flush to the scroller's top — sticky offsets
				    resolve against the padding edge. */}
				<DashboardLayout.Scroll className="pt-0">
					<div className="shrink-0 space-y-4 py-4">
						<SessionHeader summary={summary} />
						{truncated && (
							<Alert variant="warning">
								<AlertDescription>
									This session has more spans than one response carries — everything after
									the {summary.spanCount.toLocaleString()} spans below is missing, so the
									totals and the waterfall both stop early.
								</AlertDescription>
							</Alert>
						)}
					</div>
					{/* Content-driven height inside the scroller: `shrink-0` because a
					    scroll container's flex items shrink to fit before they overflow,
					    which would collapse the views instead of scrolling them; `grow`
					    (basis auto, not `flex-1`'s basis 0) so short content still fills
					    the viewport; the floor keeps the empty states from a sliver. */}
					<div className="flex min-h-64 shrink-0 grow flex-col">
						<SessionViews
							turns={turns}
							summary={summary}
							selection={selection}
							onOpenTrace={openTrace}
						/>
					</div>
				</DashboardLayout.Scroll>
			</DashboardLayout.Content>
			{/* Inline beside the content above `lg`, a sheet below it that opens on
			    selection. Empty children render no rail at all. */}
			<DashboardLayout.RightPanel
				title="Span detail"
				width="w-[28rem]"
				open={selection !== undefined}
				onOpenChange={(open) => {
					if (!open) closeTrace()
				}}
			>
				{selection === undefined ? undefined : (
					<TraceSpanDetailPanel
						traceId={selection.traceId}
						timestamp={paneTimestamp}
						selectedSpanId={selection.spanId}
						onClose={closeTrace}
					/>
				)}
			</DashboardLayout.RightPanel>
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

/** The identifying facts the list row carried and this page had dropped. */
function sessionSubtitle(summary: SessionSummary): string {
	return [
		primaryVendorLabel(summary.vendorIds),
		formatRelativeTimeOrDate(summary.startMs),
		`${summary.traceCount.toLocaleString()} trace${summary.traceCount === 1 ? "" : "s"}`,
	].join(" · ")
}

function primaryVendorLabel(vendorIds: readonly string[]): string {
	const vendorId = vendorIds[0]
	return vendorId === undefined ? "Agent session" : vendorLabel(vendorId)
}
