import type { ServicesSearchParams } from "@/routes/services/index"

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Environment", include: "environments", exclude: "excludedEnvironments" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Commit SHA", include: "commitShas", exclude: "excludedCommitShas" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof ServicesSearchParams
	exclude: keyof ServicesSearchParams
}>

export interface ServiceFilterChipDescriptor {
	param: keyof ServicesSearchParams
	label: string
	values: readonly string[]
	negated: boolean
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function serviceFilterChips(
	search: Pick<ServicesSearchParams, (typeof FACETS)[number]["include" | "exclude"]>,
): ServiceFilterChipDescriptor[] {
	const chips: ServiceFilterChipDescriptor[] = []
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
