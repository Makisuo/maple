import type { PodsSearchParams } from "@/routes/infra/kubernetes/pods/index"

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Pod", include: "podNames", exclude: "excludedPodNames" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
	{ label: "Node", include: "nodeNames", exclude: "excludedNodeNames" },
	{ label: "Cluster", include: "clusters", exclude: "excludedClusters" },
	{ label: "Deployment", include: "deployments", exclude: "excludedDeployments" },
	{ label: "StatefulSet", include: "statefulsets", exclude: "excludedStatefulsets" },
	{ label: "DaemonSet", include: "daemonsets", exclude: "excludedDaemonsets" },
	{ label: "Job", include: "jobs", exclude: "excludedJobs" },
	{ label: "Environment", include: "environments", exclude: "excludedEnvironments" },
	{ label: "Compute Type", include: "computeTypes", exclude: "excludedComputeTypes" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof PodsSearchParams
	exclude: keyof PodsSearchParams
}>

export interface PodFilterChipDescriptor {
	param: keyof PodsSearchParams
	label: string
	values: readonly string[]
	negated: boolean
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function podFilterChips(
	search: Pick<PodsSearchParams, (typeof FACETS)[number]["include" | "exclude"]>,
): PodFilterChipDescriptor[] {
	const chips: PodFilterChipDescriptor[] = []
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
