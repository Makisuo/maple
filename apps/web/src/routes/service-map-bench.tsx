import { createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { cn } from "@maple/ui/utils"

import {
	DEFAULT_BENCH_PARAMS,
	ServiceMapBench,
	type BenchParams,
	type BenchRps,
} from "@/components/service-map/service-map-bench"

// TanStack Router pre-parses numeric search params into numbers before
// validateSearch runs, so accept Number (not NumberFromString) here.
const benchSearchSchema = Schema.Struct({
	services: Schema.optional(Schema.Number),
	edges: Schema.optional(Schema.Number),
	rps: Schema.optional(Schema.Literals(["low", "med", "high"])),
	seed: Schema.optional(Schema.Number),
	// Number of `service.namespace` groups to spread services across (0 = none,
	// which keeps the perf-bench path identical to today). e.g. ?groups=4
	groups: Schema.optional(Schema.Number),
	// Declutter paths: low-traffic threshold (% of peak) and focused service.
	minTraffic: Schema.optional(Schema.Number),
	focus: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/service-map-bench"))({
	component: ServiceMapBenchPage,
	validateSearch: Schema.toStandardSchemaV1(benchSearchSchema),
})

const GROUP_OPTIONS = [0, 3, 6, 10]

function ServiceMapBenchPage() {
	const search = Route.useSearch()
	const navigate = Route.useNavigate()

	// Dev/CI-only synthetic perf harness — inert in production builds.
	if (!import.meta.env.DEV) return null

	const params: BenchParams = {
		services: search.services ?? DEFAULT_BENCH_PARAMS.services,
		edges: search.edges ?? DEFAULT_BENCH_PARAMS.edges,
		rps: (search.rps as BenchRps | undefined) ?? DEFAULT_BENCH_PARAMS.rps,
		seed: search.seed ?? DEFAULT_BENCH_PARAMS.seed,
		groups: search.groups ?? DEFAULT_BENCH_PARAMS.groups,
		minTraffic: search.minTraffic ?? DEFAULT_BENCH_PARAMS.minTraffic,
		focus: search.focus ?? DEFAULT_BENCH_PARAMS.focus,
	}
	const benchKey = JSON.stringify(params)

	return (
		<div className="relative h-screen w-screen">
			{/* Namespace-group control — flips ?groups so the ELK grouped layout can
			    be exercised without hand-editing the URL. */}
			<div className="absolute left-1/2 top-2 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-card/90 px-2 py-1 backdrop-blur-sm">
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Namespace groups
				</span>
				{GROUP_OPTIONS.map((g) => (
					<button
						key={g}
						type="button"
						onClick={() => navigate({ search: (prev) => ({ ...prev, groups: g }) })}
						className={cn(
							"rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors",
							g === params.groups
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{g === 0 ? "off" : g}
					</button>
				))}
			</div>
			<ServiceMapBench key={benchKey} params={params} />
		</div>
	)
}
