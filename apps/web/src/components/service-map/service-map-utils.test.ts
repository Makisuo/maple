import { describe, expect, it } from "vitest"
import {
	buildFlowElements,
	computeFlatPositions,
	computeNodePositions,
	dbNodeId,
	getHealthColor,
	getPlatformColor,
	getServiceMapNodeColor,
	parseDbNodeId,
	topologyKey,
	type ServiceNodeData,
} from "./service-map-utils"
import type { ServiceDbEdge, ServiceEdge, ServicePlatform } from "@/api/warehouse/service-map"
import type { ServiceOverview } from "@/api/warehouse/services"

const baseEdge = (overrides: Partial<ServiceEdge> = {}): ServiceEdge => ({
	sourceService: "api",
	targetService: "auth",
	callCount: 100,
	estimatedCallCount: 100,
	errorCount: 0,
	errorRate: 0,
	avgDurationMs: 5,
	p95DurationMs: 10,
	hasSampling: false,
	samplingWeight: 1,
	...overrides,
})

const baseDbEdge = (overrides: Partial<ServiceDbEdge> = {}): ServiceDbEdge => ({
	sourceService: "api",
	dbSystem: "clickhouse",
	dbNamespace: "",
	callCount: 50,
	estimatedCallCount: 50,
	errorCount: 0,
	errorRate: 0,
	avgDurationMs: 8,
	p95DurationMs: 20,
	hasSampling: false,
	samplingWeight: 1,
	...overrides,
})

const baseOverview = (overrides: Partial<ServiceOverview> = {}): ServiceOverview =>
	({
		serviceName: "api",
		environment: "prod",
		throughput: 10,
		tracedThroughput: 10,
		hasSampling: false,
		samplingWeight: 1,
		errorRate: 0,
		errorCount: 0,
		spanCount: 100,
		p50LatencyMs: 5,
		p95LatencyMs: 10,
		p99LatencyMs: 15,
		commits: [],
		...overrides,
	}) as unknown as ServiceOverview

describe("buildFlowElements", () => {
	it("emits a database node and edge when given a db edge", () => {
		const result = buildFlowElements({
			edges: [baseEdge()],
			dbEdges: [baseDbEdge()],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
		})

		const dbNode = result.nodes.find((n) => n.id === dbNodeId("clickhouse", ""))
		expect(dbNode).toBeDefined()
		const data = dbNode!.data as ServiceNodeData
		expect(data.kind).toBe("database")
		expect(data.label).toBe("clickhouse")
		expect(data.dbSystem).toBe("clickhouse")
		expect(data.throughput).toBeCloseTo(50 / 60)
		expect(data.avgLatencyMs).toBe(8)

		const dbEdge = result.edges.find((e) => e.target === dbNodeId("clickhouse", ""))
		expect(dbEdge).toBeDefined()
		expect(dbEdge!.source).toBe("api")
	})

	it("attaches resolved hyperdrive configs to the Hyperdrive node and draws a dashed origin edge", () => {
		const result = buildFlowElements({
			edges: [baseEdge()],
			dbEdges: [
				baseDbEdge({ dbSystem: "postgresql", dbNamespace: "hyperdrive" }),
				baseDbEdge({ sourceService: "worker", dbSystem: "mysql", dbNamespace: "maple" }),
			],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
			planetscaleDatabases: new Map([
				["maple", { name: "maple", kind: "mysql", branchCount: 1, branches: [] }],
			]),
			hyperdriveConfigs: [
				{
					id: "a".repeat(32),
					name: "maple-db",
					originHost: "aws.connect.psdb.cloud",
					originPort: 3306,
					originScheme: "mysql",
					originDatabase: "maple",
					originUser: "reader",
				},
			],
		})

		const hyperdriveNode = result.nodes.find((n) => n.id === dbNodeId("postgresql", "hyperdrive"))
		expect(hyperdriveNode).toBeDefined()
		const data = hyperdriveNode!.data as ServiceNodeData
		expect(data.hyperdrive).toHaveLength(1)
		expect(data.hyperdrive![0]!.matched).toEqual({ name: "maple", kind: "mysql" })

		// Other db nodes stay clean.
		const psNode = result.nodes.find((n) => n.id === dbNodeId("mysql", "maple"))
		expect((psNode!.data as ServiceNodeData).hyperdrive).toBeUndefined()

		const originEdge = result.edges.find((e) => e.data?.relation === "hyperdrive-origin")
		expect(originEdge).toBeDefined()
		expect(originEdge!.source).toBe(dbNodeId("postgresql", "hyperdrive"))
		expect(originEdge!.target).toBe(dbNodeId("mysql", "maple"))
		expect(originEdge!.data!.callCount).toBe(0)
	})

	it("skips the dashed origin edge when the matched PlanetScale node is not on the map", () => {
		const result = buildFlowElements({
			edges: [baseEdge()],
			dbEdges: [baseDbEdge({ dbSystem: "postgresql", dbNamespace: "hyperdrive" })],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
			planetscaleDatabases: new Map([
				["maple", { name: "maple", kind: "mysql", branchCount: 1, branches: [] }],
			]),
			hyperdriveConfigs: [
				{
					id: "a".repeat(32),
					name: "maple-db",
					originHost: "aws.connect.psdb.cloud",
					originPort: 3306,
					originScheme: "mysql",
					originDatabase: "maple",
					originUser: "reader",
				},
			],
		})

		// The panel data is still attached…
		const hyperdriveNode = result.nodes.find((n) => n.id === dbNodeId("postgresql", "hyperdrive"))
		expect((hyperdriveNode!.data as ServiceNodeData).hyperdrive).toHaveLength(1)
		// …but no synthetic edge points at a node that doesn't exist.
		expect(result.edges.some((e) => e.data?.relation === "hyperdrive-origin")).toBe(false)
	})

	it("attaches platform info to service nodes", () => {
		const platforms = new Map<string, ServicePlatform>([
			["api", "cloudflare"],
			["auth", "kubernetes"],
		])

		const result = buildFlowElements({
			edges: [baseEdge()],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
			platforms,
		})

		const apiNode = result.nodes.find((n) => n.id === "api")
		const authNode = result.nodes.find((n) => n.id === "auth")
		expect((apiNode!.data as ServiceNodeData).platform).toBe("cloudflare")
		expect((authNode!.data as ServiceNodeData).platform).toBe("kubernetes")
	})

	it("aggregates multiple callers into one db node", () => {
		const result = buildFlowElements({
			edges: [],
			dbEdges: [
				baseDbEdge({ sourceService: "api", callCount: 50, errorCount: 0 }),
				baseDbEdge({ sourceService: "worker", callCount: 30, errorCount: 3 }),
			],
			serviceOverviews: [],
			durationSeconds: 60,
		})

		const dbNodes = result.nodes.filter((n) => n.id.startsWith("db:"))
		expect(dbNodes).toHaveLength(1)
		const data = dbNodes[0].data as ServiceNodeData
		expect(data.errorRate).toBeCloseTo(3 / 80)

		const dbEdges = result.edges.filter((e) => e.target === dbNodeId("clickhouse", ""))
		expect(dbEdges).toHaveLength(2)
	})

	it("splits databases of the same system by namespace", () => {
		const result = buildFlowElements({
			edges: [],
			dbEdges: [
				baseDbEdge({ sourceService: "api", dbSystem: "postgresql", dbNamespace: "orders" }),
				baseDbEdge({ sourceService: "api", dbSystem: "postgresql", dbNamespace: "billing" }),
				baseDbEdge({ sourceService: "worker", dbSystem: "postgresql", dbNamespace: "orders" }),
			],
			serviceOverviews: [],
			durationSeconds: 60,
		})

		const dbNodes = result.nodes.filter((n) => n.id.startsWith("db:"))
		expect(dbNodes.map((n) => n.id).sort()).toEqual([
			dbNodeId("postgresql", "billing"),
			dbNodeId("postgresql", "orders"),
		])
		const orders = result.nodes.find((n) => n.id === dbNodeId("postgresql", "orders"))
		const data = orders!.data as ServiceNodeData
		// Named databases show the namespace as the node label…
		expect(data.label).toBe("orders")
		expect(data.dbSystem).toBe("postgresql")
		expect(data.dbNamespace).toBe("orders")
		// …and both callers of "orders" target the same node.
		const orderEdges = result.edges.filter((e) => e.target === dbNodeId("postgresql", "orders"))
		expect(orderEdges.map((e) => e.source).sort()).toEqual(["api", "worker"])
	})

	it("round-trips db node ids through parseDbNodeId, including ':' in components", () => {
		const id = dbNodeId("postgre:sql", "orders:main")
		expect(parseDbNodeId(id)).toEqual({ dbSystem: "postgre:sql", dbNamespace: "orders:main" })
		expect(parseDbNodeId(dbNodeId("clickhouse", ""))).toEqual({
			dbSystem: "clickhouse",
			dbNamespace: "",
		})
	})
})

describe("buildFlowElements namespace", () => {
	it("attaches namespace to service nodes but not db nodes", () => {
		const result = buildFlowElements({
			edges: [baseEdge()],
			dbEdges: [baseDbEdge({ dbSystem: "postgresql" })],
			serviceOverviews: [baseOverview({ serviceName: "api", serviceNamespace: "backend" })],
			durationSeconds: 60,
		})
		const apiNode = result.nodes.find((n) => n.id === "api")
		const dbNode = result.nodes.find((n) => n.id === dbNodeId("postgresql", ""))
		expect((apiNode!.data as ServiceNodeData).namespace).toBe("backend")
		expect((dbNode!.data as ServiceNodeData).namespace).toBeUndefined()
	})

	it("treats an empty namespace string as no namespace", () => {
		const result = buildFlowElements({
			edges: [baseEdge()],
			serviceOverviews: [baseOverview({ serviceName: "api", serviceNamespace: "" })],
			durationSeconds: 60,
		})
		const apiNode = result.nodes.find((n) => n.id === "api")
		expect((apiNode!.data as ServiceNodeData).namespace).toBeUndefined()
	})
})

describe("computeNodePositions namespace clustering", () => {
	it("matches the flat layout when no namespace is defined", () => {
		const { nodes, edges } = buildFlowElements({
			edges: [baseEdge({ sourceService: "api", targetService: "auth" })],
			serviceOverviews: [],
			durationSeconds: 3600,
		})
		expect(computeNodePositions(nodes, edges)).toEqual(computeFlatPositions(nodes, edges))
	})

	it("places each namespace's services in disjoint vertical bands", () => {
		const { nodes, edges } = buildFlowElements({
			edges: [
				baseEdge({ sourceService: "api", targetService: "auth" }),
				baseEdge({ sourceService: "web", targetService: "cart" }),
			],
			serviceOverviews: [
				baseOverview({ serviceName: "api", serviceNamespace: "backend" }),
				baseOverview({ serviceName: "auth", serviceNamespace: "backend" }),
				baseOverview({ serviceName: "web", serviceNamespace: "frontend" }),
				baseOverview({ serviceName: "cart", serviceNamespace: "frontend" }),
			],
			durationSeconds: 3600,
		})
		const pos = computeNodePositions(nodes, edges)
		const bandOf = (ids: string[]) => {
			const ys = ids.map((id) => pos.get(id)!.y)
			return { min: Math.min(...ys), max: Math.max(...ys) }
		}
		const backend = bandOf(["api", "auth"])
		const frontend = bandOf(["web", "cart"])
		const NODE_H = 70
		const disjoint = backend.max + NODE_H <= frontend.min || frontend.max + NODE_H <= backend.min
		expect(disjoint).toBe(true)
	})

	it("lays out databases below the namespaced clusters", () => {
		const { nodes, edges } = buildFlowElements({
			edges: [baseEdge({ sourceService: "api", targetService: "auth" })],
			dbEdges: [baseDbEdge({ sourceService: "api", dbSystem: "postgresql" })],
			serviceOverviews: [
				baseOverview({ serviceName: "api", serviceNamespace: "backend" }),
				baseOverview({ serviceName: "auth", serviceNamespace: "backend" }),
			],
			durationSeconds: 3600,
		})
		const pos = computeNodePositions(nodes, edges)
		const dbY = pos.get(dbNodeId("postgresql", ""))!.y
		const maxServiceY = Math.max(pos.get("api")!.y, pos.get("auth")!.y)
		expect(dbY).toBeGreaterThan(maxServiceY)
	})
})

describe("getServiceMapNodeColor", () => {
	it("colors database nodes with the dedicated db palette regardless of mode", () => {
		const dbData = { label: "clickhouse", kind: "database" as const, errorRate: 0 }
		expect(getServiceMapNodeColor(dbData, "service")).toBe(
			getServiceMapNodeColor(dbData, "health"),
		)
		expect(getServiceMapNodeColor(dbData, "platform")).toBe(
			getServiceMapNodeColor(dbData, "service"),
		)
	})

	it("returns severity colors in health mode based on error-rate buckets", () => {
		const base = { label: "api", kind: "service" as const, platform: undefined }
		expect(getServiceMapNodeColor({ ...base, errorRate: 0.06 }, "health")).toBe(
			"var(--severity-error)",
		)
		expect(getServiceMapNodeColor({ ...base, errorRate: 0.02 }, "health")).toBe(
			"var(--severity-warn)",
		)
		expect(getServiceMapNodeColor({ ...base, errorRate: 0 }, "health")).toBe(
			"var(--severity-info)",
		)
	})

	it("derives platform colors in platform mode", () => {
		const k8s = getServiceMapNodeColor({ label: "api", kind: "service", errorRate: 0, platform: "kubernetes" }, "platform",
		)
		const cf = getServiceMapNodeColor({ label: "api", kind: "service", errorRate: 0, platform: "cloudflare" }, "platform",
		)
		const unknown = getServiceMapNodeColor({ label: "api", kind: "service", errorRate: 0, platform: undefined }, "platform",
		)
		expect(k8s).toBe(getPlatformColor("kubernetes"))
		expect(cf).toBe(getPlatformColor("cloudflare"))
		expect(unknown).toBe(getPlatformColor(undefined))
		expect(k8s).not.toBe(cf)
	})

	it("falls back to per-service legend color in service mode", () => {
		const apiColor = getServiceMapNodeColor({ label: "api", kind: "service", errorRate: 0 }, "service",
		)
		const authColor = getServiceMapNodeColor({ label: "auth", kind: "service", errorRate: 0 }, "service",
		)
		expect(apiColor).not.toBe(authColor)
	})

	it("getHealthColor matches the bucket boundaries used by the helper", () => {
		expect(getHealthColor(0.0)).toBe("var(--severity-info)")
		expect(getHealthColor(0.011)).toBe("var(--severity-warn)")
		expect(getHealthColor(0.06)).toBe("var(--severity-error)")
	})
})

describe("topologyKey", () => {
	it("is stable when only metric values change (no re-layout on refresh)", () => {
		const a = buildFlowElements({
			edges: [baseEdge()],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
		})
		const b = buildFlowElements({
			edges: [baseEdge({ callCount: 999_999, errorRate: 0.5, avgDurationMs: 1234 })],
			serviceOverviews: [baseOverview({ throughput: 9999 })],
			durationSeconds: 60,
		})
		expect(topologyKey(a.nodes, a.edges)).toBe(topologyKey(b.nodes, b.edges))
	})

	it("changes when an edge introduces a new node", () => {
		const a = buildFlowElements({
			edges: [baseEdge()],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
		})
		const b = buildFlowElements({
			edges: [baseEdge(), baseEdge({ sourceService: "api", targetService: "billing" })],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
		})
		expect(topologyKey(a.nodes, a.edges)).not.toBe(topologyKey(b.nodes, b.edges))
	})

	it("is order-independent for the same topology", () => {
		const built = buildFlowElements({
			edges: [
				baseEdge({ sourceService: "api", targetService: "auth" }),
				baseEdge({ sourceService: "api", targetService: "billing" }),
			],
			serviceOverviews: [baseOverview()],
			durationSeconds: 60,
		})
		const reversed = {
			nodes: [...built.nodes].reverse(),
			edges: [...built.edges].reverse(),
		}
		expect(topologyKey(built.nodes, built.edges)).toBe(topologyKey(reversed.nodes, reversed.edges))
	})
})
