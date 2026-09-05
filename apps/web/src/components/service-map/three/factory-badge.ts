import { KAFKA_MARK_PATH } from "@/components/icons/kafka"
import { NATS_MARK_PATH } from "@/components/icons/nats"
import { RABBITMQ_MARK_PATH } from "@/components/icons/rabbitmq"
import { getDbDescriptor } from "../service-map-db"
import { resolveRuntimeGlyph } from "../service-map-runtime"
import type { Node3D } from "./types"

export type MachineBadge = {
	label: string
} & ({ path: string; wordmark?: never } | { wordmark: string; path?: never })

/** Only identified technologies get a plate. A database's system always wins
 * over runtime metadata, which can belong to the client querying it. */
export function resolveMachineBadge(node: Pick<Node3D, "kind" | "system" | "runtime">): MachineBadge | null {
	if (node.system || node.kind === "database" || node.kind === "queue") {
		const system = node.system?.trim().toLowerCase()
		switch (system) {
			case "kafka":
				return { label: "Kafka", path: KAFKA_MARK_PATH }
			case "nats":
				return { label: "NATS", path: NATS_MARK_PATH }
			case "rabbitmq":
				return { label: "RabbitMQ", path: RABBITMQ_MARK_PATH }
		}
		const database = getDbDescriptor(system)
		return database.markPath ? { label: database.label, path: database.markPath } : null
	}
	const runtime = node.runtime && resolveRuntimeGlyph(node.runtime)
	if (!runtime) return null
	return runtime.path
		? { label: runtime.full, path: runtime.path }
		: { label: runtime.full, wordmark: runtime.full.length <= 6 ? runtime.full : runtime.short }
}
