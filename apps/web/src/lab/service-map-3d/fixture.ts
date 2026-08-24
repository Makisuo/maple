import type { ServicePlatform } from "@/api/warehouse/service-map"

/**
 * Hand-shaped topology for the 3D service-map experiment.
 *
 * Deliberately not the production `ServiceEdge`/`ServiceOverview` shape: the lab
 * only needs what the renderer draws (identity, tier hints, traffic, health), and
 * a flat literal is far easier to reshape while playing with the visuals than the
 * warehouse bundle is. ~25 nodes is the size where the plumbing is the point —
 * the 2D bench already covers "does it survive 120 services".
 */

export type Node3DKind = "edge" | "service" | "database" | "queue" | "external"

export interface Node3D {
	id: string
	label: string
	kind: Node3DKind
	/** OTel `service.namespace`; drives the vertical column a node sits in. */
	namespace: string
	platform: ServicePlatform
	/** Requests per second handled by the node. */
	throughput: number
	errorRate: number
	p95LatencyMs: number
	/** `db.system` / messaging system, for database and queue nodes. */
	system?: string
}

export interface Edge3D {
	source: string
	target: string
	callsPerSecond: number
	errorRate: number
	avgLatencyMs: number
	p95LatencyMs: number
}

export interface Topology3D {
	nodes: ReadonlyArray<Node3D>
	edges: ReadonlyArray<Edge3D>
}

const service = (
	id: string,
	namespace: string,
	platform: ServicePlatform,
	throughput: number,
	errorRate: number,
	p95LatencyMs: number,
): Node3D => ({ id, label: id, kind: "service", namespace, platform, throughput, errorRate, p95LatencyMs })

const store = (
	id: string,
	label: string,
	system: string,
	namespace: string,
	throughput: number,
	errorRate: number,
	p95LatencyMs: number,
	kind: Node3DKind = "database",
): Node3D => ({
	id,
	label,
	kind,
	namespace,
	platform: "unknown",
	system,
	throughput,
	errorRate,
	p95LatencyMs,
})

const NODES: ReadonlyArray<Node3D> = [
	{
		id: "browser",
		label: "browser",
		kind: "edge",
		namespace: "edge",
		platform: "web",
		throughput: 1840,
		errorRate: 0.004,
		p95LatencyMs: 620,
	},
	service("cdn-edge", "edge", "cloudflare", 1810, 0.002, 18),
	service("api-gateway", "edge", "cloudflare", 1240, 0.006, 34),

	service("storefront-bff", "storefront", "kubernetes", 720, 0.008, 148),
	service("catalog-api", "storefront", "kubernetes", 610, 0.003, 62),
	service("search-api", "storefront", "kubernetes", 260, 0.011, 210),
	service("media-resizer", "storefront", "lambda", 95, 0.021, 480),

	service("checkout-api", "checkout", "kubernetes", 180, 0.017, 240),
	service("payments-api", "checkout", "kubernetes", 165, 0.032, 390),
	service("orders-worker", "checkout", "kubernetes", 150, 0.009, 175),
	service("inventory-api", "checkout", "kubernetes", 205, 0.005, 88),

	service("identity-api", "identity", "kubernetes", 430, 0.002, 54),
	service("session-edge", "identity", "cloudflare", 980, 0.001, 9),

	service("notifications-worker", "platform", "kubernetes", 70, 0.014, 320),
	service("ingest-collector", "platform", "kubernetes", 2400, 0.0007, 12),

	store("db:postgresql/orders", "orders", "postgresql", "data", 320, 0.001, 24),
	store("db:postgresql/catalog", "catalog", "postgresql", "data", 640, 0.0004, 11),
	store("db:mysql/identity", "identity", "mysql", "data", 470, 0.0008, 8),
	store("db:redis/session-cache", "session-cache", "redis", "data", 1900, 0.0001, 1.2),
	store("db:clickhouse/events", "events", "clickhouse", "data", 210, 0.002, 96),
	store("db:opensearch/products", "products", "opensearch", "data", 250, 0.006, 140),
	store("q:kafka/order-events", "order-events", "kafka", "data", 160, 0.0005, 6, "queue"),
	store("q:sqs/emails", "emails", "sqs", "data", 72, 0.001, 14, "queue"),

	{
		id: "ext:stripe",
		label: "stripe",
		kind: "external",
		namespace: "external",
		platform: "unknown",
		throughput: 150,
		errorRate: 0.041,
		p95LatencyMs: 610,
	},
	{
		id: "ext:sendgrid",
		label: "sendgrid",
		kind: "external",
		namespace: "external",
		platform: "unknown",
		throughput: 66,
		errorRate: 0.019,
		p95LatencyMs: 430,
	},
]

const edge = (
	source: string,
	target: string,
	callsPerSecond: number,
	errorRate: number,
	avgLatencyMs: number,
	p95LatencyMs: number,
): Edge3D => ({ source, target, callsPerSecond, errorRate, avgLatencyMs, p95LatencyMs })

const EDGES: ReadonlyArray<Edge3D> = [
	edge("browser", "cdn-edge", 1810, 0.002, 12, 40),
	edge("cdn-edge", "api-gateway", 1240, 0.006, 22, 68),
	edge("cdn-edge", "session-edge", 980, 0.001, 4, 11),
	edge("api-gateway", "storefront-bff", 720, 0.008, 96, 210),
	edge("api-gateway", "checkout-api", 180, 0.017, 165, 340),
	edge("api-gateway", "identity-api", 300, 0.002, 31, 70),
	edge("session-edge", "identity-api", 130, 0.001, 26, 58),

	edge("storefront-bff", "catalog-api", 610, 0.003, 38, 84),
	edge("storefront-bff", "search-api", 260, 0.011, 130, 260),
	edge("storefront-bff", "media-resizer", 95, 0.021, 290, 520),
	edge("storefront-bff", "inventory-api", 140, 0.005, 44, 96),

	edge("checkout-api", "payments-api", 165, 0.032, 260, 430),
	edge("checkout-api", "inventory-api", 65, 0.005, 40, 92),
	edge("checkout-api", "orders-worker", 150, 0.009, 110, 190),
	edge("payments-api", "ext:stripe", 150, 0.041, 340, 620),
	edge("orders-worker", "q:kafka/order-events", 160, 0.0005, 5, 12),
	edge("q:kafka/order-events", "notifications-worker", 70, 0.014, 210, 340),
	edge("notifications-worker", "q:sqs/emails", 72, 0.001, 9, 20),
	edge("notifications-worker", "ext:sendgrid", 66, 0.019, 280, 450),

	edge("catalog-api", "db:postgresql/catalog", 640, 0.0004, 6, 14),
	edge("catalog-api", "db:redis/session-cache", 420, 0.0001, 0.7, 1.4),
	edge("search-api", "db:opensearch/products", 250, 0.006, 88, 160),
	edge("inventory-api", "db:postgresql/catalog", 190, 0.0004, 7, 16),
	edge("orders-worker", "db:postgresql/orders", 320, 0.001, 12, 28),
	edge("identity-api", "db:mysql/identity", 470, 0.0008, 4, 9),
	edge("session-edge", "db:redis/session-cache", 950, 0.0001, 0.6, 1.1),
	edge("ingest-collector", "db:clickhouse/events", 210, 0.002, 42, 110),
	edge("api-gateway", "ingest-collector", 340, 0.0007, 6, 15),
	edge("browser", "ingest-collector", 210, 0.0007, 8, 22),
]

export const SERVICE_MAP_3D_TOPOLOGY: Topology3D = { nodes: NODES, edges: EDGES }
