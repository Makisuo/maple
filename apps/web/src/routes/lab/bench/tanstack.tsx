import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { TanstackChartBench, type ChartRenderer } from "@/lab/bench/tanstack-chart-bench"

const tanstackBenchSearchSchema = Schema.Struct({
	renderer: Schema.optional(Schema.Literals(["recharts", "tanstack-svg", "tanstack-canvas"])),
})

export const Route = createFileRoute("/lab/bench/tanstack")({
	component: TanstackBenchPage,
	validateSearch: Schema.toStandardSchemaV1(tanstackBenchSearchSchema),
})

function TanstackBenchPage() {
	const search = Route.useSearch()

	// Omit the prop when no ?renderer= is given so the bench falls back to the
	// Recharts baseline the two TanStack arms are measured against.
	return <TanstackChartBench renderer={search.renderer as ChartRenderer | undefined} />
}
