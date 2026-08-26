import type { TracesSearchParams } from "@/routes/traces/index"

/**
 * One facet, in both polarities, as the sidebar spells it. `label` has to match the section title
 * exactly — the chip is how you find the section the filter lives in.
 */
const FACETS = [
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Root Span", include: "spanNames", exclude: "excludedSpanNames" },
	{ label: "HTTP Method", include: "httpMethods", exclude: "excludedHttpMethods" },
	{ label: "Status Code", include: "httpStatusCodes", exclude: "excludedHttpStatusCodes" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof TracesSearchParams
	exclude: keyof TracesSearchParams
}>

export interface TraceFilterChipDescriptor {
	/** The search param this chip owns, and what clearing it clears. */
	param: keyof TracesSearchParams
	label: string
	values: readonly string[]
	negated: boolean
}

/**
 * The applied facet filters, ordered as the sidebar orders its sections, with exclusions pinned
 * ahead of inclusions.
 *
 * Exclusions lead because they are the ones that cannot be read off the results: an inclusion shows
 * up as what came back, an exclusion only as what didn't.
 */
export function traceFilterChips(
	search: Pick<TracesSearchParams, (typeof FACETS)[number]["include" | "exclude"]>,
): TraceFilterChipDescriptor[] {
	const chips: TraceFilterChipDescriptor[] = []
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
