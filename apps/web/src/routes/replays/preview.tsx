import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ReplayStudio } from "@/components/replays/replay-studio"
import {
	PREVIEW_RRWEB_EVENTS,
	PREVIEW_SESSION,
	PREVIEW_TRACE_SUMMARIES,
	PREVIEW_TRANSCRIPT,
} from "@/components/replays/preview-fixtures"

// TEMPORARY preview route: renders the session-replay detail page against
// hand-built placeholder data (no warehouse needed) so the polished UI can be
// reviewed end-to-end. Delete this file + preview-fixtures.ts when done.
export const Route = createFileRoute("/replays/preview")({
	component: ReplayPreviewPage,
})

function ReplayPreviewPage() {
	const session = PREVIEW_SESSION
	const breadcrumbs = [{ label: "Session Replays", href: "/replays" }, { label: "Preview" }]

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={breadcrumbs} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title="Session Replay (preview)" />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<ReplayStudio
							sessionId={session.sessionId}
							session={session}
							traceIds={[]}
							preview={{
								rrwebEvents: PREVIEW_RRWEB_EVENTS,
								traceSummaries: PREVIEW_TRACE_SUMMARIES,
								transcript: PREVIEW_TRANSCRIPT,
							}}
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
