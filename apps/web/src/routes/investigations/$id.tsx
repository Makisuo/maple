import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"

import { decodeInvestigationRef } from "@/components/chat/investigation-context"
import { InvestigationView } from "@/components/investigations/investigation-view"
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
})

export const Route = createFileRoute("/investigations/$id")({
	component: InvestigationPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

const decodeInvestigationId = Schema.decodeUnknownSync(InvestigationId)

function InvestigationPage() {
	const { id: rawId } = Route.useParams()
	const { r } = Route.useSearch()
	const id = decodeInvestigationId(rawId)
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
		.onError(() => {
			const legacyRef = r ? decodeInvestigationRef(r) : undefined
			return legacyRef ? <LegacyInvestigationRedirect legacyId={rawId} /> : <NotFoundShell />
		})
		.onSuccess((investigation) => <InvestigationView investigation={investigation} onRefresh={refresh} />)
		.render()
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
			<MutationFailureShell
				title="Investigation migration failed"
				description="The legacy investigation could not be migrated."
				onRetry={migrate}
			/>
		)
	}
	return <LoadingShell label="Migrating investigation…" />
}

function MutationFailureShell({
	title,
	description,
	onRetry,
}: {
	title: string
	description: string
	onRetry: () => void
}) {
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Investigations", href: "/investigations" }, { label: "Error" }]}
			title={title}
		>
			<Empty>
				<EmptyHeader>
					<EmptyTitle>{title}</EmptyTitle>
					<EmptyDescription>{description}</EmptyDescription>
				</EmptyHeader>
				<Button variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
			</Empty>
		</DashboardLayout>
	)
}

function LoadingShell({ label = "Loading investigation…" }: { label?: string }) {
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Investigations", href: "/investigations" }, { label: "…" }]}
			title={label}
		>
			<div className="mx-auto w-full max-w-4xl space-y-4">
				<Skeleton className="h-4 w-32" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-56 w-full" />
			</div>
		</DashboardLayout>
	)
}

function NotFoundShell() {
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Investigations", href: "/investigations" }, { label: "Missing" }]}
			title="Investigation not found"
		>
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
		</DashboardLayout>
	)
}
