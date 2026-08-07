import type { ReactNode } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit, Option, Schema } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"

import { decodeInvestigationRef } from "@/components/chat/investigation-context"
import { INVESTIGATION_TABS } from "@/components/investigations/investigation-tabs"
import { InvestigationView } from "@/components/investigations/investigation-view"
import { ErrorState } from "@/components/common/error-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { InvestigationId } from "@maple/domain/http"
import { useState } from "react"

const SearchSchema = Schema.Struct({
	/** One-release redirect shim for legacy encoded resource URLs. */
	r: Schema.optional(Schema.String),
	/**
	 * The open tab. Absent means Overview, so the canonical URL for an
	 * investigation stays clean and a link to Evidence survives a reload.
	 */
	tab: Schema.optional(Schema.Literals(INVESTIGATION_TABS)),
})

export const Route = createFileRoute("/investigations/$id")({
	component: InvestigationPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

const decodeInvestigationId = Schema.decodeUnknownOption(InvestigationId)

function InvestigationPage() {
	const { id: rawId } = Route.useParams()
	const { r, tab } = Route.useSearch()
	// `InvestigationId` is a branded UUID. Decoding it with the throwing variant
	// took down the whole route on any other shape — including the legacy encoded
	// ids the `?r=` migration below exists to rescue, which made that path
	// unreachable.
	const decoded = decodeInvestigationId(rawId)
	if (Option.isNone(decoded)) {
		const legacyRef = r ? decodeInvestigationRef(r) : undefined
		return legacyRef ? <LegacyInvestigationRedirect legacyId={rawId} /> : <NotFoundShell />
	}
	return <InvestigationDetail id={decoded.value} legacyRef={r} rawId={rawId} tab={tab} />
}

function InvestigationDetail({
	id,
	legacyRef,
	rawId,
	tab,
}: {
	id: InvestigationId
	legacyRef: string | undefined
	rawId: string
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
			if (legacyRef && decodeInvestigationRef(legacyRef)) {
				return <LegacyInvestigationRedirect legacyId={rawId} />
			}
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
			<InvestigationView investigation={investigation} tab={tab ?? "overview"} onRefresh={refresh} />
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

function LegacyInvestigationRedirect({ legacyId }: { legacyId: string }) {
	const navigate = useNavigate()
	const create = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})
	const [failed, setFailed] = useState(false)
	const migrate = () => {
		setFailed(false)
		void create({
			payload: {
				subject: {
					type: "freeform",
					title: "Migrated investigation",
					prompt: `Continue the legacy incident investigation for ${legacyId}.`,
					context_refs: [{ legacy_id: legacyId }],
				},
				snapshot: {
					title: "Migrated investigation",
					scope: null,
					status: "open",
					severity: null,
					facts: [{ label: "Legacy resource", value: legacyId }],
					references: [],
					incidentStartedAt: null,
					incidentEndedAt: null,
				},
			},
			reactivityKeys: ["investigations"],
		}).then((result) => {
			if (Exit.isSuccess(result)) {
				void navigate({
					to: "/investigations/$id",
					params: { id: result.value.id },
					replace: true,
				})
			} else {
				setFailed(true)
			}
		})
	}
	useMountEffect(migrate)
	if (failed) {
		return (
			<InvestigationShell trail="Error" title="Investigation migration failed">
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Investigation migration failed</EmptyTitle>
						<EmptyDescription>The legacy investigation could not be migrated.</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" onClick={migrate}>
						Try again
					</Button>
				</Empty>
			</InvestigationShell>
		)
	}
	return <LoadingShell label="Migrating investigation…" />
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
