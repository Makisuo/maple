import { Suspense, type ComponentType } from "react"
import type { PlotProps } from "@maple/ui/components/charts/_shared/chart-types"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

interface ChartPreviewProps {
	/**
	 * Any registry entry's `component`. The registry is discriminated on `kind`
	 * and each entry carries its chart's exact props, but every one of those is a
	 * supertype of `PlotProps`, so a caller that only sets `data` needs no switch.
	 */
	component: ComponentType<PlotProps>
	/**
	 * Sample rows for the gallery tile — pass the registry entry's `sampleData`.
	 *
	 * The gallery is explicitly a sample preview, so the fixtures belong here at
	 * the call site rather than inside the chart components. A chart that
	 * substitutes fixtures for missing data on its own can't tell a real empty
	 * result from a misconfigured query, which is how a broken histogram ended up
	 * rendering a plausible-looking distribution on a live dashboard.
	 */
	data?: Record<string, unknown>[]
}

export function ChartPreview({ component: Component, data }: ChartPreviewProps) {
	return (
		<div className="aspect-[4/3] w-full overflow-hidden">
			<Suspense fallback={<Skeleton className="h-full w-full" />}>
				<Component className="h-full w-full aspect-auto" data={data} />
			</Suspense>
		</div>
	)
}
