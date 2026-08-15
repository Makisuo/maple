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
import { useMemo } from "react"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import {
	useShareWidgetData,
	useSharedDashboard,
	type ShareResolveError,
	type SharedDashboard,
	type ShareTimeRange,
} from "@/hooks/use-share-dashboard"
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

/** Warehouse datetime format, which is what the share API accepts. */
const formatWarehouseTime = (date: Date): string => date.toISOString().replace("T", " ").slice(0, 19)

const DEFAULT_RANGE_HOURS = 12

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

	const timeRange = useMemo<ShareTimeRange>(() => {
		const now = new Date()
		const from =
			search.from ?? formatWarehouseTime(new Date(now.getTime() - DEFAULT_RANGE_HOURS * 3600_000))
		const to = search.to ?? formatWarehouseTime(now)
		return { startTime: from, endTime: to }
		// Recomputed only when the URL changes: a fresh `new Date()` on every
		// render would re-key the fetch effect forever.
	}, [search.from, search.to])

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
		<ShareShell embed={search.embed === true} title={state.share.dashboard.name}>
			<ShareGrid
				share={state.share}
				token={token}
				timeRange={timeRange}
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
	title,
}: {
	children: React.ReactNode
	embed: boolean
	title?: string
}) {
	if (embed) {
		// Nothing but the tile. An embed lives inside someone else's layout, and
		// any header of ours would be furniture in their document.
		//
		// `h-screen`, not `h-full`: the iframe's viewport IS the available height,
		// and `h-full` on a chain with no sized ancestor collapses the chart to its
		// header.
		return <div className="h-screen w-full bg-background p-2">{children}</div>
	}

	return (
		<div className="flex min-h-screen flex-col bg-background">
			<header className="flex items-center justify-between border-b px-6 py-3">
				{title ? <h1 className="font-medium text-sm">{title}</h1> : <span />}
				<span className="text-muted-foreground text-xs">Shared via Maple</span>
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

function ShareGrid({
	share,
	token,
	timeRange,
	signedIn,
	embed,
}: {
	share: SharedDashboard
	token: string
	timeRange: ShareTimeRange
	signedIn: boolean
	embed: boolean
}) {
	const widgetIds = useMemo(
		() => share.dashboard.widgets.map((widget) => widget.id),
		[share.dashboard.widgets],
	)
	const variableValues = useMemo<Record<string, string>>(() => ({}), [])
	const { states } = useShareWidgetData(token, widgetIds, timeRange, variableValues, true, signedIn)

	const single = share.scope === "widget"

	return (
		<div className={single ? "h-full w-full" : "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"}>
			{share.dashboard.widgets.map((widget) => {
				const Visualization = visualizationFor(widget.visualization)
				const dataState = states[widget.id] ?? { status: "loading" as const }
				return (
					<div
						key={widget.id}
						// Sizing only, no border or padding: every visualization already
						// draws its own card, so chrome here lands as a second frame around
						// the first.
						//
						// Height is set against the viewport rather than a flex chain — the
						// chart library measures its own container, and `h-full` through
						// ancestors with no definite height collapses it to the title row.
						className={
							single
								? embed
									? "h-[calc(100vh-1rem)] w-full"
									: "h-[calc(100vh-9rem)] w-full"
								: "h-64"
						}
					>
						<Visualization
							dataState={dataState}
							display={widget.display}
							// Always "view": a share has no editing affordances to gate,
							// and passing anything else would surface them.
							mode="view"
							rowLimit={(widget.dataSource.transform as { limit?: number } | undefined)?.limit}
						/>
					</div>
				)
			})}
		</div>
	)
}
