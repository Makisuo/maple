import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { ChartsLab, type ChartsLabArm, type ChartsLabRenderer } from "@/lab/charts/charts-lab"

const chartsLabSearchSchema = Schema.Struct({
	renderer: Schema.optional(Schema.Literals(["tanstack-svg", "tanstack-canvas"])),
	arm: Schema.optional(
		Schema.Literals([
			"pie-production",
			"pie-tanstack",
			"histogram-production",
			"histogram-tanstack",
			"heatmap-production",
			"heatmap-tanstack",
			"line-production",
			"line-tanstack",
			"area-production",
			"area-tanstack",
			"stacked-bar-production",
			"stacked-bar-tanstack",
			"line-incomplete-production",
			"line-incomplete-tanstack",
			"area-incomplete-production",
			"area-incomplete-tanstack",
			"stacked-bar-incomplete-tanstack",
			"box-plot",
			"trace-scatter",
			"sankey",
			"treemap",
		]),
	),
})

export const Route = createFileRoute("/lab/charts")({
	component: ChartsLabPage,
	validateSearch: Schema.toStandardSchemaV1(chartsLabSearchSchema),
})

function ChartsLabPage() {
	const search = Route.useSearch()

	// Omit when absent so the gallery exercises its real default (canvas), and so
	// no `arm` means the side-by-side view with no measurement harness.
	return (
		<ChartsLab
			renderer={search.renderer as ChartsLabRenderer | undefined}
			arm={search.arm as ChartsLabArm | undefined}
		/>
	)
}
