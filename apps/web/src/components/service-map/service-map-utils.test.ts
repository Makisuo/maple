import { describe, expect, it } from "vitest"
import {
	buildFlowElements,
	dbNodeId,
	getHealthColor,
	getPlatformColor,
	getServiceMapNodeColor,
	type ServiceNodeData,
} from "./service-map-utils"
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

describe("getServiceMapNodeColor", () => {
	const services = ["api", "auth", "worker"]

	it("colors database nodes with the dedicated db palette regardless of mode", () => {
		const dbData = { label: "clickhouse", kind: "database" as const, errorRate: 0 }
		expect(getServiceMapNodeColor(dbData, services, "service")).toBe(
			getServiceMapNodeColor(dbData, services, "health"),
		)
		expect(getServiceMapNodeColor(dbData, services, "platform")).toBe(
			getServiceMapNodeColor(dbData, services, "service"),
		)
	})

	it("returns severity colors in health mode based on error-rate buckets", () => {
		const base = { label: "api", kind: "service" as const, platform: undefined }
		expect(getServiceMapNodeColor({ ...base, errorRate: 0.06 }, services, "health")).toBe(
			"var(--severity-error)",
		)
		expect(getServiceMapNodeColor({ ...base, errorRate: 0.02 }, services, "health")).toBe(
			"var(--severity-warn)",
		)
		expect(getServiceMapNodeColor({ ...base, errorRate: 0 }, services, "health")).toBe(
			"var(--severity-info)",
		)
	})

	it("derives platform colors in platform mode", () => {
		const k8s = getServiceMapNodeColor(
			{ label: "api", kind: "service", errorRate: 0, platform: "kubernetes" },
			services,
			"platform",
		)
		const cf = getServiceMapNodeColor(
			{ label: "api", kind: "service", errorRate: 0, platform: "cloudflare" },
			services,
			"platform",
		)
		const unknown = getServiceMapNodeColor(
			{ label: "api", kind: "service", errorRate: 0, platform: undefined },
			services,
			"platform",
		)
		expect(k8s).toBe(getPlatformColor("kubernetes"))
		expect(cf).toBe(getPlatformColor("cloudflare"))
		expect(unknown).toBe(getPlatformColor(undefined))
		expect(k8s).not.toBe(cf)
	})

	it("falls back to per-service legend color in service mode", () => {
		const apiColor = getServiceMapNodeColor(
			{ label: "api", kind: "service", errorRate: 0 },
			services,
			"service",
		)
		const authColor = getServiceMapNodeColor(
			{ label: "auth", kind: "service", errorRate: 0 },
			services,
			"service",
		)
		expect(apiColor).not.toBe(authColor)
	})

	it("getHealthColor matches the bucket boundaries used by the helper", () => {
		expect(getHealthColor(0.0)).toBe("var(--severity-info)")
		expect(getHealthColor(0.011)).toBe("var(--severity-warn)")
		expect(getHealthColor(0.06)).toBe("var(--severity-error)")
	})
})
