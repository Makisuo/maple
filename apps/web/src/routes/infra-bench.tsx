import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { InfraChartBench, type InfraBenchSyncMode } from "@/components/infra/infra-chart-bench"

const infraBenchSearchSchema = Schema.Struct({
	mode: Schema.optional(Schema.Literals(["recharts", "cursor"])),
})

export const Route = createFileRoute("/infra-bench")({
	component: InfraBenchPage,
	validateSearch: Schema.toStandardSchemaV1(infraBenchSearchSchema),
})

function InfraBenchPage() {
	const search = Route.useSearch()

	// DEV-only synthetic perf harness — inert in production builds.
	if (!import.meta.env.DEV) return null

	// Omit the prop when no ?mode= is given so the bench exercises the infra
	// ChartViews' real default — the perf spec asserts that default stays "cursor".
	return <InfraChartBench syncMode={search.mode as InfraBenchSyncMode | undefined} />
}
