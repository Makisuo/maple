import type { LogsSearchParams } from "@/routes/logs/index"

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Severity", include: "severities", exclude: "excludedSeverities" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof LogsSearchParams
	exclude: keyof LogsSearchParams
}>

export interface LogFilterChipDescriptor {
	param: keyof LogsSearchParams
	label: string
	values: readonly string[]
	negated: boolean
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function logFilterChips(
	search: Pick<LogsSearchParams, (typeof FACETS)[number]["include" | "exclude"] | "traceId">,
): LogFilterChipDescriptor[] {
	const chips: LogFilterChipDescriptor[] = []
	// The trace scope leads even the exclusions: it redefines what the page shows
	// (one trace's logs) rather than trimming it, and it has no sidebar section.
	if (search.traceId) {
		chips.push({ param: "traceId", label: "Trace", values: [search.traceId], negated: false })
	}
	for (const facet of FACETS) {
		const excluded = search[facet.exclude]
		if (excluded?.length) {
			chips.push({ param: facet.exclude, label: facet.label, values: excluded, negated: true })
		}
	}
	for (const facet of FACETS) {
		const included = search[facet.include]
		if (included?.length) {
			chips.push({ param: facet.include, label: facet.label, values: included, negated: false })
		}
	}
	return chips
}
