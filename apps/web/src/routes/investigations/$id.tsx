import type { ReactNode } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Option, Schema } from "effect"

import { INVESTIGATION_TABS } from "@/components/investigations/investigation-tabs"
import { ProvenanceCanvasLoading } from "@/components/investigations/flow/provenance-loading"
import { InvestigationView } from "@/components/investigations/investigation-view"
import { ErrorState } from "@/components/common/error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useInvestigation } from "@/hooks/use-investigation"
import { retryOrgCollections } from "@/lib/collections/org-collections"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { InvestigationId } from "@maple/domain/http"

const SearchSchema = Schema.Struct({
	/**
	 * The open tab. Absent means Overview, so the canonical URL for an
	 * investigation stays clean and a link to Evidence survives a reload.
	 */
	tab: Schema.optional(Schema.Literals(INVESTIGATION_TABS)),
	/**
	 * The open proposed-action detail, by index into the report's actions, so the
	 * panel is linkable and survives a reload.
	 *
	 * Written as a number by `navigate`, which the router serialises as JSON — so
	 * the address bar reads `?action=1`. Typing it as `Schema.String` instead put
	 * `?action=%221%22` in the URL, which round-trips but is not a link anyone
	 * would write by hand.
	 *
	 * `Unknown` rather than `Number` because `validateSearch` is a throwing
	 * boundary: `?action=abc` against a number schema takes down the whole route
	 * behind an error boundary, and a mangled query string should cost the panel,
	 * not the investigation. The view narrows it.
	 */
	action: Schema.optional(Schema.Unknown),
})

export const Route = createFileRoute("/investigations/$id")({
	component: InvestigationPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

const decodeInvestigationId = Schema.decodeUnknownOption(InvestigationId)

function InvestigationPage() {
	const { id: rawId } = Route.useParams()
	const { tab, action } = Route.useSearch()
	// A malformed branded UUID is a normal not-found result, not a route error.
	const decoded = decodeInvestigationId(rawId)
	if (Option.isNone(decoded)) return <NotFoundShell />
	return <InvestigationDetail action={action} id={decoded.value} tab={tab} />
}

/**
 * The page's data is an ElectricSQL shape, not a fetch.
 *
 * It used to poll `/v2/investigations/:id` every 3s while a run was in flight,
 * which put a three-second floor under every transition the provenance canvas
 * draws — a lane going `checking`, a progress note, the verdict landing. The two
 * shapes (`investigations` + its lens lanes) are recombined into the same
 * `V2Investigation` this view already took, so nothing below here changed.
 */
function InvestigationDetail({
	action,
	id,
	tab,
}: {
	action: unknown
	id: InvestigationId
	tab: (typeof INVESTIGATION_TABS)[number] | undefined
}) {
	const sync = useInvestigation(id)

	switch (sync.state) {
		case "loading":
			return <LoadingShell />
		// The shape synced and this org has no such row. Unlike a dropped request,
		// this IS a dead end — the sync is authoritative about what the org holds.
		case "missing":
			return <NotFoundShell />
		// The stream gave up (or never loaded) — a transport problem, not a missing
		// investigation. Telling someone their investigation is gone when it isn't
		// sends them looking for a problem that doesn't exist, so this stays a retry.
		case "failed":
			return (
				<LoadFailureShell
					error={new Error("The live connection to this investigation was lost")}
					onRetry={retryOrgCollections}
				/>
			)
		case "ready":
			return (
				<InvestigationView
					action={action}
					investigation={sync.investigation}
					tab={tab ?? "overview"}
				/>
			)
	}
}

/**
 * Every non-success state wears the same chrome — breadcrumbs, a sticky header,
 * a scrolling body — and four hand-copied versions of it drifted apart the moment
 * anything about the shell changed. Only the trail label, the title and the body
 * differ, so those are the parameters.
 */
function InvestigationShell({
	trail,
	title,
	children,
}: {
	trail: string
	title: string
	children: ReactNode
}) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Investigations", href: "/investigations" }, { label: trail }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={title} />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>{children}</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function LoadFailureShell({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	return (
		<InvestigationShell trail="Unavailable" title="Investigation">
			<ErrorState error={error} title="This investigation could not be loaded" onRetry={onRetry} />
		</InvestigationShell>
	)
}

/**
 * The header rows are bars, but the canvas is not: it is the page's lead widget,
 * and a grey block standing in for it told the reader nothing about what was
 * coming. The ghost draws the chain it is about to be replaced by.
 */
function LoadingShell({ label = "Loading investigation…" }: { label?: string }) {
	return (
		<InvestigationShell trail="…" title={label}>
			<div className="mx-auto w-full max-w-4xl space-y-4">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-8 w-3/4" />
				<ProvenanceCanvasLoading />
			</div>
		</InvestigationShell>
	)
}

function NotFoundShell() {
	return (
		<InvestigationShell trail="Missing" title="Investigation not found">
			<Empty>
				<EmptyHeader>
					<EmptyTitle>This investigation is unavailable</EmptyTitle>
					<EmptyDescription>
						It may have been removed, or it belongs to a different organization.
					</EmptyDescription>
				</EmptyHeader>
				<Button variant="outline" size="sm" render={<Link to="/investigations" />}>
					View investigations
				</Button>
			</Empty>
		</InvestigationShell>
	)
}
