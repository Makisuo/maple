import type { Edge, Node } from "@xyflow/react"
import type { ServiceEdgeData, ServiceNodeData } from "../service-map-utils"
import type { Node3DKind, Topology3D } from "./types"

const QUEUE_SYSTEMS = new Set(["kafka", "rabbitmq", "sqs", "aws_sqs", "nats", "pulsar"])

/** Consume the same resolved, filtered graph as 2D; preserve sample-weighted rates and metric meanings. */
export function liveTopology(
	nodes: ReadonlyArray<Node<ServiceNodeData>>,
	edges: ReadonlyArray<Edge<ServiceEdgeData>>,
	dimmedNodes: ReadonlySet<string>,
	dimmedEdges: ReadonlySet<string>,
): Topology3D {
	const ids = new Set(nodes.map((node) => node.id))
	return {
		nodes: nodes.map(({ id, data }) => {
			const kind: Node3DKind =
				data.kind === "database"
					? QUEUE_SYSTEMS.has(data.dbSystem ?? "")
						? "queue"
						: data.hyperdrive
							? "external"
							: "database"
					: data.platform === "web"
						? "edge"
						: "service"
			return {
				id,
				label:
					data.kind === "namespaceAggregate"
						? `${data.label} (${data.nsMemberCount ?? 0})`
						: data.label,
				kind,
				namespace: data.namespace || (data.kind === "database" ? "databases" : "services"),
				platform: data.platform ?? "unknown",
				runtime: data.runtime,
				system: data.dbSystem,
				throughput: data.throughput,
				errorRate: data.errorRate,
				p95LatencyMs: data.p95LatencyMs,
				hasSampling: data.hasSampling,
				dimmed: dimmedNodes.has(id),
			}
		}),
		edges: edges.flatMap(({ id, source, target, data }) => {
			if (!data || !ids.has(source) || !ids.has(target)) return []
			return [
				{
					source,
					target,
					callsPerSecond: data.estimatedCallsPerSecond,
					errorRate: data.errorRate,
					avgLatencyMs: data.avgDurationMs,
					maxLatencyMs: data.maxDurationMs,
					hasSampling: data.hasSampling,
					relation: data.relation,
					dimmed: dimmedEdges.has(id),
				},
			]
		}),
	}
}
