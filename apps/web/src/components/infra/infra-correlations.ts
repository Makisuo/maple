// Declarative trace/log -> infrastructure correlation config.
//
// Ported from HyperDX's `infraCorrelations.ts` pattern: opening any span or log
// row whose resource attributes carry k8s/host identity surfaces an
// "Infrastructure" tab showing that pod/node/host's metrics. `detectAttribute`
// gates whether a group appears; the resolved `identifier` (+ `namespace` for
// pods) drives both the reused chart components and the deep-link into the
// existing infra detail routes.
//
// This is the SINGLE source of truth for both the tab-visibility gate and the
// panel renderer, so the two never drift. Keep it React-free — it is unit
// tested directly.

import type {
	ContainerInfraMetric,
	HostInfraMetric,
	NodeInfraMetric,
	PodInfraMetric,
} from "@/api/warehouse/infra"

interface InfraCorrelationBase {
	/** Display heading for the group ("Container" | "Pod" | "Node" | "Host"). */
	title: string
	/** Resource-attribute key whose presence gated this group. */
	detectAttribute: string
	/**
	 * Resolved identity value (pod / node / host name), kept raw — the deep-link
	 * is built by `CorrelationLink` via TanStack `<Link to/params/search>`, which
	 * owns URL encoding, so this value is passed through verbatim.
	 */
	identifier: string
}

/**
 * One active correlation group. Discriminated on `kind` so each group's
 * `charts` carry the metric-name literal type its chart component expects —
 * no inline casts needed at the render site.
 */
export type InfraCorrelation =
	| (InfraCorrelationBase & {
			kind: "container"
			/** Narrows the deep-link — container names collide across hosts. */
			hostName?: string
			charts: ReadonlyArray<{ label: string; metric: ContainerInfraMetric }>
	  })
	| (InfraCorrelationBase & {
			kind: "pod"
			namespace?: string
			charts: ReadonlyArray<{ label: string; metric: PodInfraMetric }>
	  })
	| (InfraCorrelationBase & {
			kind: "node"
			charts: ReadonlyArray<{ label: string; metric: NodeInfraMetric }>
	  })
	| (InfraCorrelationBase & {
			kind: "host"
			charts: ReadonlyArray<{ label: string; metric: HostInfraMetric }>
	  })

// Charts shown per kind. Pod has no disk metric (kubeletstats doesn't emit one
// in Maple's pipeline), so it shows CPU usage + the two limit-utilization
// gauges; host mirrors HyperDX's CPU / Memory / Disk trio.
const CONTAINER_CHARTS: ReadonlyArray<{ label: string; metric: ContainerInfraMetric }> = [
	{ label: "CPU", metric: "cpu" },
	{ label: "Memory / limit", metric: "memory_percent" },
	{ label: "Network I/O", metric: "network" },
]

const POD_CHARTS: ReadonlyArray<{ label: string; metric: PodInfraMetric }> = [
	{ label: "CPU cores", metric: "cpu_usage" },
	{ label: "CPU / limit", metric: "cpu_limit" },
	{ label: "Memory / limit", metric: "memory_limit" },
]

const NODE_CHARTS: ReadonlyArray<{ label: string; metric: NodeInfraMetric }> = [
	{ label: "CPU cores", metric: "cpu_usage" },
	{ label: "Uptime", metric: "uptime" },
]

const HOST_CHARTS: ReadonlyArray<{ label: string; metric: HostInfraMetric }> = [
	{ label: "CPU", metric: "cpu" },
	{ label: "Memory", metric: "memory" },
	{ label: "Disk", metric: "filesystem" },
]

const CONTAINER_NAME_KEY = "container.name"
const POD_NAME_KEY = "k8s.pod.name"
const POD_NAMESPACE_KEY = "k8s.namespace.name"
const NODE_NAME_KEY = "k8s.node.name"
const HOST_NAME_KEY = "host.name"

function attr(
	resourceAttributes: Record<string, string> | null | undefined,
	key: string,
): string | undefined {
	const value = resourceAttributes?.[key]
	// Metric/span resource maps default missing keys to "", which must not count
	// as present (it would query/link to an empty identifier).
	return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Returns the correlation groups whose detect attribute is present on the given
 * resource attributes, in render order (Container, Pod, Node, Host). A pod
 * span/log typically yields both Pod and Node groups, since a pod always runs
 * on a node.
 */
export function getActiveInfraCorrelations(
	resourceAttributes: Record<string, string> | null | undefined,
): InfraCorrelation[] {
	const out: InfraCorrelation[] = []

	// k8s pods also carry `container.name`, but their per-container metrics come
	// from kubeletstats, not dockerstats — a container group there would render
	// an empty duplicate chart stack, so k8s identity suppresses it.
	const containerName = attr(resourceAttributes, CONTAINER_NAME_KEY)
	const k8sPodName = attr(resourceAttributes, POD_NAME_KEY)
	if (containerName && !k8sPodName) {
		out.push({
			kind: "container",
			title: "Container",
			detectAttribute: CONTAINER_NAME_KEY,
			identifier: containerName,
			hostName: attr(resourceAttributes, HOST_NAME_KEY),
			charts: CONTAINER_CHARTS,
		})
	}

	const podName = attr(resourceAttributes, POD_NAME_KEY)
	if (podName) {
		out.push({
			kind: "pod",
			title: "Pod",
			detectAttribute: POD_NAME_KEY,
			identifier: podName,
			namespace: attr(resourceAttributes, POD_NAMESPACE_KEY),
			charts: POD_CHARTS,
		})
	}

	const nodeName = attr(resourceAttributes, NODE_NAME_KEY)
	if (nodeName) {
		out.push({
			kind: "node",
			title: "Node",
			detectAttribute: NODE_NAME_KEY,
			identifier: nodeName,
			charts: NODE_CHARTS,
		})
	}

	const hostName = attr(resourceAttributes, HOST_NAME_KEY)
	if (hostName) {
		out.push({
			kind: "host",
			title: "Host",
			detectAttribute: HOST_NAME_KEY,
			identifier: hostName,
			charts: HOST_CHARTS,
		})
	}

	return out
}
