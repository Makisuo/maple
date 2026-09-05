import type { ServicePlatform } from "@/api/warehouse/service-map"

export type Vec3 = readonly [number, number, number]

export type Node3DKind = "edge" | "service" | "database" | "queue" | "external"

export interface Node3D {
	id: string
	label: string
	kind: Node3DKind
	/** OTel `service.namespace`; drives the vertical column a node sits in. */
	namespace: string
	platform: ServicePlatform
	/** OTel `process.runtime.name`, shared with the 2D map. */
	runtime?: string
	/** Requests per second handled by the node. */
	throughput: number
	errorRate: number
	hasSampling?: boolean
	dimmed?: boolean
	p95LatencyMs?: number
	/** `db.system` / messaging system, for database and queue nodes. */
	system?: string
}

export interface Edge3D {
	source: string
	target: string
	callsPerSecond: number
	errorRate: number
	hasSampling?: boolean
	dimmed?: boolean
	avgLatencyMs: number
	maxLatencyMs?: number
	relation?: "hyperdrive-origin"
	p95LatencyMs?: number
}

export interface Topology3D {
	nodes: ReadonlyArray<Node3D>
	edges: ReadonlyArray<Edge3D>
}
