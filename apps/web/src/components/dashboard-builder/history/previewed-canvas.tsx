import { useState } from "react"
import type { DashboardId } from "@maple/domain/http"
import { Result } from "@/lib/effect-atom"
import {
	withActiveTab,
	withSectionCollapsed,
	type SectionViewSearch,
} from "@/lib/dashboards/section-view-state"
import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"
import { DashboardSections } from "@/components/dashboard-builder/sections/dashboard-sections"
import { PreviewBanner } from "./preview-banner"
import { useDashboardVersionDetail } from "./use-dashboard-history"
import type { PreviewedVersion } from "@/atoms/dashboard-history-atoms"

interface PreviewedCanvasProps {
	dashboardId: DashboardId
	preview: PreviewedVersion
	onCancel: () => void
	onRestored: () => void
}

export function PreviewedCanvas({ dashboardId, preview, onCancel, onRestored }: PreviewedCanvasProps) {
	const result = useDashboardVersionDetail(dashboardId, preview.versionId)
	const [viewSearch, setViewSearch] = useState<SectionViewSearch>({})

	return (
		<div>
			<PreviewBanner
				dashboardId={dashboardId}
				preview={preview}
				onCancel={onCancel}
				onRestored={onRestored}
			/>

			{Result.isSuccess(result) ? (
				// Rendered through the sectioned canvas, not the flat one: a snapshot
				// taken after groups existed would otherwise preview as one
				// undifferentiated wall of tiles that looks nothing like what
				// restoring it would actually produce. Read-only, and the view
				// callbacks are inert — a preview has no URL state of its own.
				<DashboardSections
					widgets={result.value.snapshot.widgets as unknown as DashboardWidget[]}
					sections={(result.value.snapshot.sections ?? []) as unknown as DashboardSection[]}
					// Local, not URL-backed: browsing a preview's groups is throwaway
					// state, and writing it to the URL would leave collapse/tab params
					// behind after the preview is dismissed. Inert callbacks were the
					// alternative, but a tab bar you can click and nothing happens
					// reads as broken.
					search={viewSearch}
					onToggleCollapsed={(sectionId, collapsed) =>
						setViewSearch((prev) => withSectionCollapsed(prev, sectionId, collapsed))
					}
					onSelectTab={(sectionId, tabId) =>
						setViewSearch((prev) => withActiveTab(prev, sectionId, tabId))
					}
					onAddWidget={() => undefined}
					readOnly
				/>
			) : Result.isFailure(result) ? (
				<div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-6 text-xs text-destructive">
					Couldn't load version snapshot.
				</div>
			) : (
				<div className="px-4 py-12 text-center text-xs text-muted-foreground">Loading snapshot…</div>
			)}
		</div>
	)
}
