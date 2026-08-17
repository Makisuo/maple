import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { ChartsLab, type ChartsLabArm, type ChartsLabRenderer } from "@/lab/charts/charts-lab"

const chartsLabSearchSchema = Schema.Struct({
	renderer: Schema.optional(Schema.Literals(["tanstack-svg", "tanstack-canvas"])),
	arm: Schema.optional(Schema.Literals(["production", "tanstack"])),
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
