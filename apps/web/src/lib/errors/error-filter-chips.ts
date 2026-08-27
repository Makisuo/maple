import type { ErrorsSearchParams } from "@/routes/errors/index"

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Error Type", include: "errorTypes", exclude: "excludedErrorTypes" },
	{ label: "Version", include: "serviceVersions", exclude: "excludedServiceVersions" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof ErrorsSearchParams
	exclude: keyof ErrorsSearchParams
}>

export interface ErrorFilterChipDescriptor {
	param: keyof ErrorsSearchParams
	label: string
	values: readonly string[]
	negated: boolean
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function errorFilterChips(
	search: Pick<ErrorsSearchParams, (typeof FACETS)[number]["include" | "exclude"]>,
): ErrorFilterChipDescriptor[] {
	const chips: ErrorFilterChipDescriptor[] = []
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
