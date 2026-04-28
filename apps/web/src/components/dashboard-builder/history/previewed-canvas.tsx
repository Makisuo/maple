import { Result } from "@/lib/effect-atom"
import type { DashboardWidget } from "@/components/dashboard-builder/types"
import { DashboardCanvas } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { PreviewBanner } from "./preview-banner"
import { useDashboardVersionDetail } from "./use-dashboard-history"
import type { PreviewedVersion } from "@/atoms/dashboard-history-atoms"

interface PreviewedCanvasProps {
	dashboardId: string
	preview: PreviewedVersion
	onCancel: () => void
	onRestored: () => void
}

export function PreviewedCanvas({ dashboardId, preview, onCancel, onRestored }: PreviewedCanvasProps) {
	const result = useDashboardVersionDetail(dashboardId, preview.versionId)

	return (
		<div>
			<PreviewBanner
				dashboardId={dashboardId}
				preview={preview}
				onCancel={onCancel}
				onRestored={onRestored}
			/>

			{Result.isSuccess(result) ? (
				<DashboardCanvas
					widgets={result.value.snapshot.widgets as unknown as DashboardWidget[]}
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
