import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { InfraChartBench, type InfraBenchSyncMode } from "@/lab/bench/infra-chart-bench"

const infraBenchSearchSchema = Schema.Struct({
	mode: Schema.optional(Schema.Literals(["recharts", "cursor"])),
})

export const Route = createFileRoute("/lab/bench/infra")({
	component: InfraBenchPage,
	validateSearch: Schema.toStandardSchemaV1(infraBenchSearchSchema),
})

function InfraBenchPage() {
	const search = Route.useSearch()

	// Omit the prop when no ?mode= is given so the bench exercises the infra
	// ChartViews' real default — the perf spec asserts that default stays "cursor".
	return <InfraChartBench syncMode={search.mode as InfraBenchSyncMode | undefined} />
}
