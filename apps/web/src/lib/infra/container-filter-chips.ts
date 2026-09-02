import type { ContainersSearchParams } from "@/routes/infra/containers/index"

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Container", include: "containerNames", exclude: "excludedContainerNames" },
	{ label: "Image", include: "images", exclude: "excludedImages" },
	{ label: "Host", include: "hostNames", exclude: "excludedHostNames" },
	{ label: "Compose Project", include: "composeProjects", exclude: "excludedComposeProjects" },
	{ label: "Compose Service", include: "composeServices", exclude: "excludedComposeServices" },
	{ label: "Environment", include: "environments", exclude: "excludedEnvironments" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof ContainersSearchParams
	exclude: keyof ContainersSearchParams
}>

export interface ContainerFilterChipDescriptor {
	param: keyof ContainersSearchParams
	label: string
	values: readonly string[]
	negated: boolean
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function containerFilterChips(
	search: Pick<ContainersSearchParams, (typeof FACETS)[number]["include" | "exclude"]>,
): ContainerFilterChipDescriptor[] {
	const chips: ContainerFilterChipDescriptor[] = []
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
