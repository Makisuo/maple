/**
 * A shared dashboard, or a single shared chart.
 *
 * Renders outside the app shell entirely — no sidebar, no breadcrumbs, no
 * command palette, no chat sheet. `DashboardLayout` is the authed chrome and
 * assumes a signed-in org throughout, so this page composes its own.
 *
 * `?embed` drops even this page's own header, for a public chart dropped into
 * someone else's document. The server decides whether a link may be framed at
 * all (`embeddable`); this flag only controls how much chrome is drawn.
 *
 * Those are two separate checks and both are needed. `?embed` is chosen by
 * whoever wrote the URL, so it cannot gate anything; `embeddable` comes off the
 * resolve response and is gated below, in `FrameGate`. The worker serves this
 * route without `frame-ancestors` precisely so embedding is possible at all —
 * which makes the page the only layer that knows which token it is holding, and
 * therefore the only one that can enforce the server's answer.
 */
import { createFileRoute } from "@tanstack/react-router"
import { useAuth } from "@clerk/clerk-react"
import { Schema } from "effect"
import { useCallback, useMemo, useState } from "react"
import { resolveTimeRange } from "@/atoms/dashboard-time-range-atoms"
import { ReadOnlyDashboardView } from "@/components/dashboard-builder/read-only-dashboard-view"
import {
	SharedWidgetRenderer,
	ShareWidgetOptionsReporterProvider,
	ShareWidgetStatesProvider,
	type ShareWidgetOptionsReporter,
} from "@/components/share/shared-widget-renderer"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { formatTimeRangeDisplay, presetLabel } from "@/lib/time-utils"
import {
	shareTimeRange,
	useShareWidgetData,
	useSharedDashboard,
	type ShareResolveError,
	type SharedDashboard,
	type ShareTimeRange,
	type ShareWidgetRequestOptions,
} from "@/hooks/use-share-dashboard"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { Button } from "@maple/ui/components/ui/button"

const ShareSearch = Schema.Struct({
	/**
	 * `?embed=true` renders the chrome-less embed variant.
	 *
	 * A real boolean, not a presence flag: TanStack's search parser JSON-decodes
	 * values, so `?embed=1` arrives as the number 1 and fails a string schema.
	 */
	embed: Schema.optional(Schema.Boolean),
	from: Schema.optional(Schema.String),
	to: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/share/$token")({
	component: SharePage,
	validateSearch: Schema.toStandardSchemaV1(ShareSearch),
})

/**
 * The window a share is viewed over, and how to describe it.
 *
 * `?from`/`?to` pin an absolute window; otherwise it is the board's own stored
 * `timeRange`, resolved through the same `resolveTimeRange` the signed-in
 * dashboard seeds its picker from — same relative grammar, same cache-grid
 * snapping, same `"1h"` fallback for a stored preset this build cannot read.
 * The share page used to hardcode "last 12 hours" here, which is how a board on
 * "Last 1 hour" shared as a board on twelve.
 */
interface ShareWindow {
	readonly timeRange: ShareTimeRange
	readonly label: string
}

const DEFAULT_SHARE_TIME_RANGE = { type: "relative", value: "1h" } as const

const resolveShareWindow = (
	search: { readonly from?: string; readonly to?: string },
	stored: unknown,
): ShareWindow | null => {
	if (search.from !== undefined && search.to !== undefined) {
		return {
			timeRange: { startTime: search.from, endTime: search.to },
			label: formatTimeRangeDisplay(search.from, search.to),
		}
	}
	const timeRange = shareTimeRange(stored) ?? DEFAULT_SHARE_TIME_RANGE
	const resolved = resolveTimeRange(timeRange)
	if (resolved === null) return null
	return {
		timeRange: resolved,
		label:
			timeRange.type === "relative"
				? presetLabel(timeRange.value)
				: formatTimeRangeDisplay(resolved.startTime, resolved.endTime),
	}
}

/**
 * Split in two so `useAuth` is never called conditionally.
 *
 * A share page must render for a signed-out viewer, and in self-hosted mode
 * there is no Clerk provider to call at all — the same reason `org-required`
 * splits this way.
 */
function SharePage() {
	return isClerkAuthEnabled ? <SharePageWithClerk /> : <SharePageContent isSignedIn={false} />
}

function SharePageWithClerk() {
	const { isSignedIn } = useAuth()
	return <SharePageContent isSignedIn={isSignedIn === true} />
}

function SharePageContent({ isSignedIn }: { isSignedIn: boolean }) {
	const { token } = Route.useParams()
	const search = Route.useSearch()
	const state = useSharedDashboard(token, isSignedIn)

	if (state.status === "loading") {
		return (
			<ShareShell embed={search.embed === true}>
				<ShareSkeleton />
			</ShareShell>
		)
	}

	if (state.status === "error") {
		return (
			<ShareShell embed={search.embed === true}>
				<ShareErrorCard error={state.error} />
			</ShareShell>
		)
	}

	// Checked after resolve, because `embeddable` is the server's answer about
	// this specific token — not something the URL or the page can decide.
	if (isFramed() && !state.share.embeddable) {
		return (
			<ShareShell embed={search.embed === true}>
				<NotEmbeddableCard />
			</ShareShell>
		)
	}

	return (
		<ShareShell
			embed={search.embed === true}
			scope={state.share.scope}
			title={state.share.dashboard.name}
		>
			<ShareBody
				share={state.share}
				token={token}
				from={search.from}
				to={search.to}
				signedIn={isSignedIn}
				embed={search.embed === true}
			/>
		</ShareShell>
	)
}

/**
 * Whether this document is inside a frame.
 *
 * Cross-origin, reading `window.top` throws rather than answering, and a throw
 * means we are framed by someone we cannot see — the exact case this gates. So
 * the catch returns `true`: the safe answer, not the convenient one.
 */
const isFramed = (): boolean => {
	if (typeof window === "undefined") return false
	try {
		return window.self !== window.top
	} catch {
		return true
	}
}

/**
 * Only a public single-chart link may be framed, and the API decides which
 * those are. This is the page half of that: the worker serves `/share/` without
 * `frame-ancestors` so embedding is possible at all, which leaves the decision
 * here, where the resolved share is known.
 *
 * A client-side check is weaker than a header and is not pretending otherwise.
 * It is the layer that has the information, and the case it covers degrades
 * safely regardless: an org-only link in a cross-origin frame carries no
 * session, so it renders the sign-in card rather than any data.
 */
function NotEmbeddableCard() {
	return (
		<CenteredCard
			title="This link can't be embedded"
			body="Only a shared chart set to public can be displayed inside another site. Open the link directly instead."
		/>
	)
}

function ShareShell({
	children,
	embed,
	scope = "widget",
	title,
}: {
	children: React.ReactNode
	embed: boolean
	/** A board scrolls; a single chart is sized to the frame. */
	scope?: SharedDashboard["scope"]
	title?: string
}) {
	if (embed) {
		// Nothing but the tile. An embed lives inside someone else's layout, and
		// any header of ours would be furniture in their document.
		//
		// `h-screen`, not `h-full`: the iframe's viewport IS the available height,
		// and `h-full` on a chain with no sized ancestor collapses the chart to its
		// header.
		//
		// A whole board is the opposite case — it is as tall as its grid, so
		// pinning it to the viewport would clip the lower rows with no way to
		// scroll to them. `min-h-screen` still gives the canvas a definite width
		// to measure, which is all `useContainerSize` needs.
		const height = scope === "dashboard" ? "min-h-screen" : "h-screen"
		return <div className={`${height} w-full bg-background p-2`}>{children}</div>
	}

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<header className="flex items-center justify-between border-b px-6 py-3">
				{title ? <h1 className="font-medium text-sm">{title}</h1> : <span />}
				<a
					href="https://maple.dev"
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
				>
					<span>Shared via</span>
					<MapleMark size={14} className="shrink-0" aria-hidden="true" />
					<span className="font-medium">Maple</span>
				</a>
			</header>
			<main className="flex-1 p-6">{children}</main>
		</div>
	)
}

function ShareSkeleton() {
	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
			{[0, 1, 2, 3].map((index) => (
				// The skeleton draws its own card because there is no visualization
				// mounted yet to draw one — unlike the real tiles, which do.
				<div key={index} className="h-64 animate-pulse rounded-lg border bg-muted/30" />
			))}
		</div>
	)
}

function ShareErrorCard({ error }: { error: ShareResolveError }) {
	const signIn = () => {
		const redirect = encodeURIComponent(window.location.pathname + window.location.search)
		window.location.href = `/sign-in?redirect_url=${redirect}`
	}

	// Deliberately not an auto-redirect. Bouncing an anonymous viewer straight to
	// a login form makes "this link is org-only" indistinguishable from "your
	// session expired", and strands anyone who has no account at all on a page
	// that never explains why.
	if (error.kind === "signin_required") {
		return (
			<CenteredCard
				title="Sign in to view this dashboard"
				body="This dashboard is shared with its organization only."
			>
				<Button onClick={signIn}>Sign in</Button>
			</CenteredCard>
		)
	}

	if (error.kind === "wrong_org") {
		return (
			<CenteredCard
				title="You don't have access to this dashboard"
				body="It's shared with a different organization. Switch organizations and try again."
			/>
		)
	}

	if (error.kind === "rate_limited") {
		return (
			<CenteredCard
				title="Too many requests"
				body="This shared dashboard is busy right now. Try again in a moment."
			/>
		)
	}

	// Unknown, revoked, and deleted all arrive here identically, which is the
	// point — the page must not become the oracle the API refuses to be.
	return (
		<CenteredCard
			title="This link isn't available"
			body={
				error.kind === "unavailable"
					? error.message
					: "The link may have been revoked, or it never existed."
			}
		/>
	)
}

function CenteredCard({
	title,
	body,
	children,
}: {
	title: string
	body: string
	children?: React.ReactNode
}) {
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<div className="max-w-md space-y-3 rounded-lg border p-8 text-center">
				<h2 className="font-medium text-lg">{title}</h2>
				<p className="text-muted-foreground text-sm">{body}</p>
				{children ? <div className="pt-2">{children}</div> : null}
			</div>
		</div>
	)
}

/**
 * Data for every tile on the share, then the board.
 *
 * Both scopes fetch the same way — one batched call set for every widget id —
 * and differ only in what they draw: a whole board goes through the same canvas
 * the authed dashboard uses, so tiles land on their authored positions and
 * sizes, while a single chart has no grid to be placed in at all.
 */
function ShareBody({
	share,
	token,
	from,
	to,
	signedIn,
	embed,
}: {
	share: SharedDashboard
	token: string
	from: string | undefined
	to: string | undefined
	signedIn: boolean
	embed: boolean
}) {
	// Recomputed only when the URL or the resolved board changes: re-resolving
	// a relative preset on every render would re-key the fetch effect forever.
	const window = useMemo(
		() => resolveShareWindow({ from, to }, share.dashboard.timeRange),
		[from, to, share.dashboard.timeRange],
	)
	const variableValues = useMemo<Record<string, string>>(() => ({}), [])

	// Each mounted tile reports its request options (its measured width) here;
	// a widget is fetched once it has — and only it refetches when its options
	// change. Tiles in a collapsed group or an inactive tab never mount, never
	// report, and are never queried, exactly as on the signed-in board.
	const [options, setOptions] = useState<Readonly<Record<string, ShareWidgetRequestOptions>>>({})
	const report = useCallback<ShareWidgetOptionsReporter>((widgetId, next) => {
		setOptions((current) => {
			const previous = current[widgetId]
			if (previous !== undefined && previous.maxDataPoints === next.maxDataPoints) return current
			return { ...current, [widgetId]: next }
		})
	}, [])
	const reportedWidgets = useMemo(
		() => share.dashboard.widgets.filter((widget) => options[widget.id] !== undefined),
		[share.dashboard.widgets, options],
	)
	const { states } = useShareWidgetData(
		token,
		reportedWidgets,
		window?.timeRange ?? EMPTY_WINDOW,
		variableValues,
		window !== null,
		signedIn,
		options,
	)

	if (window === null) {
		return (
			<CenteredCard
				title="This dashboard's time range couldn't be resolved"
				body="Open the link with an explicit window (?from=…&to=…) instead."
			/>
		)
	}

	if (share.scope === "widget") {
		return (
			<ShareWidgetOptionsReporterProvider report={report}>
				<ShareWidgetStatesProvider states={states}>
					<SingleWidgetShare share={share} embed={embed} />
				</ShareWidgetStatesProvider>
			</ShareWidgetOptionsReporterProvider>
		)
	}

	return (
		<div className="flex flex-col gap-3">
			{/* The one thing a viewer needs to compare this page with the board it
			    shares: which window they are looking at. */}
			{embed ? null : (
				<div className="text-muted-foreground text-xs" data-testid="share-time-range">
					{window.label}
				</div>
			)}
			<ShareWidgetOptionsReporterProvider report={report}>
				<ShareWidgetStatesProvider states={states}>
					<ReadOnlyDashboardView
						widgets={share.dashboard.widgets}
						sections={share.dashboard.sections}
						renderWidget={SharedWidgetRenderer}
					/>
				</ShareWidgetStatesProvider>
			</ShareWidgetOptionsReporterProvider>
		</div>
	)
}

/** Placeholder window while resolution failed; the fetch is disabled then. */
const EMPTY_WINDOW: ShareTimeRange = { startTime: "", endTime: "" }

/**
 * A single shared chart, filling the page.
 *
 * Deliberately not the dashboard canvas: `redactForShare` lifts a single-widget
 * share out of its section and publishes no layout context around it, so there
 * is no grid to place it in and nothing for authored coordinates to mean.
 */
function SingleWidgetShare({ share, embed }: { share: SharedDashboard; embed: boolean }) {
	return (
		<div className="h-full w-full">
			{share.dashboard.widgets.map((widget) => (
				<div
					key={widget.id}
					// Sizing only, no border or padding: every visualization already
					// draws its own card, so chrome here lands as a second frame around
					// the first.
					//
					// Height is set against the viewport rather than a flex chain — the
					// chart library measures its own container, and `h-full` through
					// ancestors with no definite height collapses it to the title row.
					className={embed ? "h-[calc(100vh-1rem)] w-full" : "h-[calc(100vh-9rem)] w-full"}
				>
					{/* The same tile as on a board share — same state, same measured
					    width, same badges — inside a viewport-sized box. */}
					<SharedWidgetRenderer widget={widget} />
				</div>
			))}
		</div>
	)
}
