import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { TanstackChartBench, type ChartRenderer } from "@/lab/bench/tanstack-chart-bench"

const tanstackBenchSearchSchema = Schema.Struct({
	renderer: Schema.optional(Schema.Literals(["tanstack-svg", "tanstack-canvas"])),
})

export const Route = createFileRoute("/lab/bench/tanstack")({
	component: TanstackBenchPage,
	validateSearch: Schema.toStandardSchemaV1(tanstackBenchSearchSchema),
})

function TanstackBenchPage() {
	const search = Route.useSearch()

	// Omit the prop when no ?renderer= is given so the bench falls back to the
	// bench's own default, which is `PlotFrame`'s default renderer.
	return <TanstackChartBench renderer={search.renderer as ChartRenderer | undefined} />
}
