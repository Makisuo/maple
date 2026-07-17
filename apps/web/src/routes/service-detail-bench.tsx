import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import {
	ServiceDetailChartBench,
	type ServiceDetailBenchSyncMode,
} from "@/components/services/service-detail-chart-bench"

const serviceDetailBenchSearchSchema = Schema.Struct({
	mode: Schema.optional(Schema.Literals(["recharts", "cursor"])),
})

export const Route = createFileRoute("/service-detail-bench")({
	component: ServiceDetailBenchPage,
	validateSearch: Schema.toStandardSchemaV1(serviceDetailBenchSearchSchema),
})

function ServiceDetailBenchPage() {
	const search = Route.useSearch()

	// DEV-only synthetic perf harness — inert in production builds.
	if (!import.meta.env.DEV) return null

	// Omit the prop when no ?mode= is given so the bench exercises MetricsGrid's
	// real default — the perf spec asserts that default stays "cursor".
	return <ServiceDetailChartBench syncMode={search.mode as ServiceDetailBenchSyncMode | undefined} />
}
