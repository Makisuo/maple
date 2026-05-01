import { describe, expect, it } from "vitest"
import { buildFlowElements, dbNodeId, type ServiceNodeData } from "./service-map-utils"
import type { ServiceDbEdge, ServiceEdge, ServicePlatform } from "@/api/tinybird/service-map"
import type { ServiceOverview } from "@/api/tinybird/services"

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

		const dbNode = result.nodes.find((n) => n.id === dbNodeId("clickhouse"))
		expect(dbNode).toBeDefined()
		const data = dbNode!.data as ServiceNodeData
		expect(data.kind).toBe("database")
		expect(data.label).toBe("clickhouse")
		expect(data.dbSystem).toBe("clickhouse")
		expect(data.throughput).toBeCloseTo(50 / 60)
		expect(data.avgLatencyMs).toBe(8)

		const dbEdge = result.edges.find((e) => e.target === dbNodeId("clickhouse"))
		expect(dbEdge).toBeDefined()
		expect(dbEdge!.source).toBe("api")
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

		const dbEdges = result.edges.filter((e) => e.target === dbNodeId("clickhouse"))
		expect(dbEdges).toHaveLength(2)
	})
})
