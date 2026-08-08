import type { ReactNode } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Option, Schema } from "effect"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"

import { INVESTIGATION_TABS } from "@/components/investigations/investigation-tabs"
import { InvestigationView } from "@/components/investigations/investigation-view"
import { ErrorState } from "@/components/common/error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
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

function InvestigationDetail({
	action,
	id,
	tab,
}: {
	action: unknown
	id: InvestigationId
	tab: (typeof INVESTIGATION_TABS)[number] | undefined
}) {
	const query = MapleApiV2AtomClient.query("investigations", "retrieve", {
		params: { id },
		reactivityKeys: ["investigations", `investigation:${id}`],
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const isInvestigating = Result.isSuccess(result) && result.value.status === "investigating"
	useIntervalRefresh(refresh, { intervalMs: 3_000, enabled: isInvestigating })

	return Result.builder(result)
		.onInitial(() => <LoadingShell />)
		.onError((error) => {
			// Only a real "no such investigation" is a dead end. A dropped request or
			// a restarting API is not, and telling someone their investigation is gone
			// when it isn't sends them looking for a problem that doesn't exist.
			return isNotFound(error) ? (
				<NotFoundShell />
			) : (
				<LoadFailureShell error={error} onRetry={refresh} />
			)
		})
		.onSuccess((investigation) => (
			<InvestigationView
				action={action}
				investigation={investigation}
				tab={tab ?? "overview"}
				onRefresh={refresh}
			/>
		))
		.render()
}

/** The v2 API answers a missing investigation with a tagged not-found error. */
const isNotFound = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	typeof error._tag === "string" &&
	error._tag.toLowerCase().includes("notfound")

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

function LoadingShell({ label = "Loading investigation…" }: { label?: string }) {
	return (
		<InvestigationShell trail="…" title={label}>
			<div className="mx-auto w-full max-w-4xl space-y-4">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-56 w-full" />
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
