import { useMemo } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ReplayStudio } from "@/components/replays/replay-studio"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getReplayEventsResultAtom,
	getReplayResultAtom,
	getSessionTranscriptResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { ReplayDetailSkeleton } from "@/components/replays/session-detail-parts"
import { replayPartitionWindow } from "@/components/replays/replay-format"

const detailSearchSchema = Schema.Struct({
	// Session start (warehouse timestamp), set by the list-row link. Used as a
	// partition-pruning hint so the detail queries don't scan the full 30-day
	// retention; absent on deep-links, which then fall back to a full scan.
	t: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/replays/$sessionId")({
	component: ReplayDetailPage,
	validateSearch: Schema.toStandardSchemaV1(detailSearchSchema),
	loaderDeps: ({ search }) => ({ t: search.t }),
	loader: ({ context, params, deps }) => {
		const window = replayPartitionWindow(typeof deps.t === "string" ? deps.t : undefined)
		const data = { sessionId: params.sessionId, ...window }
		context.effectRegistry.mount(getReplayResultAtom({ data }))
		context.effectRegistry.mount(getReplayEventsResultAtom({ data }))
		context.effectRegistry.mount(getSessionTranscriptResultAtom({ data }))
	},
})

function ReplayDetailPage() {
	const { sessionId } = Route.useParams()
	const search = Route.useSearch()
	// Recompute the same window the loader prefetched with, so every atom read
	// keys to the identical (prefetched) family entry rather than refetching.
	// Memoized on `t` so its identity is stable — it threads down to the memoized
	// TracesTrack, which must not re-render while the playhead scrubs.
	const t = typeof search.t === "string" ? search.t : undefined
	const window = useMemo(() => replayPartitionWindow(t), [t])
	const detailResult = useAtomValue(getReplayResultAtom({ data: { sessionId, ...window } }))

	const breadcrumbs = [{ label: "Session Replays", href: "/replays" }, { label: sessionId.slice(0, 8) }]

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout breadcrumbs={breadcrumbs} title="Loading session…">
				<ReplayDetailSkeleton />
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout breadcrumbs={breadcrumbs} title="Error">
				<QueryErrorState error={error} titleOverride="Failed to load session replay" />
			</DashboardLayout>
		))
		.onSuccess((detail) => {
			const session = detail.data
			if (!session) {
				return (
					<DashboardLayout
						breadcrumbs={breadcrumbs}
						title="Session not found"
						description="It may have expired or not been ingested yet."
					>
						<div className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
							No metadata for session <span className="font-mono">{sessionId}</span>.
						</div>
					</DashboardLayout>
				)
			}

			return (
				<DashboardLayout breadcrumbs={breadcrumbs} title="Session Replay">
					<ReplayStudio
							sessionId={sessionId}
							session={session}
							traceIds={session.traceIds}
							window={window}
						/>
				</DashboardLayout>
			)
		})
		.render()
}
