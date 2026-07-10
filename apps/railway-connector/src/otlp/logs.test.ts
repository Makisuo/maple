import { assert, describe, it } from "@effect/vitest"
import {
	buildLogsExportRequest,
	decodeRailwayLogEntry,
	severityNumberFor,
	type RailwayLogEntry,
} from "./logs"

const context = {
	projectId: "proj-1",
	projectName: "maple-demo",
	environmentId: "env-1",
	environmentName: "production",
	services: [
		{ id: "svc-1", name: "api" },
		{ id: "svc-2", name: "worker" },
	],
	observedAtMs: 1_750_000_100_000,
}

const entry = (overrides: Partial<RailwayLogEntry>): RailwayLogEntry => ({
	timestampMs: 1_750_000_000_000,
	message: "hello",
	severity: "info",
	serviceId: "svc-1",
	deploymentId: "dep-1",
	attributes: [],
	...overrides,
})

describe("decodeRailwayLogEntry", () => {
	it("decodes a full subscription entry", () => {
		const decoded = decodeRailwayLogEntry({
			timestamp: "2026-06-15T12:00:00.000Z",
			message: "GET /health 200",
			severity: "info",
			tags: { serviceId: "svc-1", deploymentId: "dep-9", environmentId: "env-1" },
			attributes: [
				{ key: "level", value: "info" },
				{ key: "requestId", value: "abc" },
			],
		})
		assert.isNotNull(decoded)
		assert.strictEqual(decoded!.timestampMs, Date.parse("2026-06-15T12:00:00.000Z"))
		assert.strictEqual(decoded!.message, "GET /health 200")
		assert.strictEqual(decoded!.serviceId, "svc-1")
		assert.strictEqual(decoded!.deploymentId, "dep-9")
		assert.strictEqual(decoded!.attributes.length, 2)
	})

	it("degrades missing tags/severity/attributes instead of dropping the line", () => {
		const decoded = decodeRailwayLogEntry({ timestamp: 1_750_000_000_000, message: "bare line" })
		assert.isNotNull(decoded)
		assert.isNull(decoded!.severity)
		assert.isNull(decoded!.serviceId)
		assert.deepStrictEqual(decoded!.attributes, [])
	})

	it("drops entries with no message or unparseable timestamp", () => {
		assert.isNull(decodeRailwayLogEntry({ timestamp: "2026-06-15T12:00:00Z" }))
		assert.isNull(decodeRailwayLogEntry({ timestamp: "not-a-date", message: "x" }))
		assert.isNull(decodeRailwayLogEntry("not an object"))
	})
})

describe("severityNumberFor", () => {
	it("maps Railway severities onto OTLP severity numbers", () => {
		assert.strictEqual(severityNumberFor("debug"), 5)
		assert.strictEqual(severityNumberFor("info"), 9)
		assert.strictEqual(severityNumberFor("warn"), 13)
		assert.strictEqual(severityNumberFor("WARNING"), 13)
		assert.strictEqual(severityNumberFor("error"), 17)
		assert.strictEqual(severityNumberFor("err"), 17)
		assert.strictEqual(severityNumberFor(null), 0)
		assert.strictEqual(severityNumberFor("weird"), 0)
	})
})

describe("buildLogsExportRequest", () => {
	it("groups entries into one resource per Railway service", () => {
		const request = buildLogsExportRequest(
			[
				entry({ serviceId: "svc-1", message: "from api" }),
				entry({ serviceId: "svc-2", message: "from worker", severity: "error" }),
				entry({ serviceId: "svc-1", message: "api again" }),
			],
			context,
		)
		assert.isNotNull(request)
		assert.strictEqual(request!.resourceLogs.length, 2)

		const api = request!.resourceLogs.find((resource) =>
			resource.resource.attributes.some(
				(attr) => attr.key === "service.name" && attr.value.stringValue === "api",
			),
		)!
		assert.strictEqual(api.scopeLogs[0]!.logRecords.length, 2)
		const attrs = Object.fromEntries(
			api.resource.attributes.map((attr) => [attr.key, attr.value.stringValue]),
		)
		assert.strictEqual(attrs["cloud.provider"], "railway")
		assert.strictEqual(attrs["service.namespace"], "maple-demo")
		assert.strictEqual(attrs["railway.project.id"], "proj-1")
		assert.strictEqual(attrs["railway.environment.name"], "production")
		assert.strictEqual(attrs["railway.service.id"], "svc-1")

		const worker = request!.resourceLogs.find((resource) =>
			resource.resource.attributes.some(
				(attr) => attr.key === "service.name" && attr.value.stringValue === "worker",
			),
		)!
		const record = worker.scopeLogs[0]!.logRecords[0]!
		assert.strictEqual(record.severityNumber, 17)
		assert.strictEqual(record.body.stringValue, "from worker")
		// Rust deserializer contract: nanosecond timestamps are strings.
		assert.strictEqual(record.timeUnixNano, "1750000000000000000")
		assert.isTrue(
			record.attributes.some(
				(attr) => attr.key === "railway.deployment.id" && attr.value.stringValue === "dep-1",
			),
		)
	})

	it("attributes unknown and missing service ids without dropping records", () => {
		const request = buildLogsExportRequest(
			[entry({ serviceId: "svc-unknown" }), entry({ serviceId: null })],
			context,
		)
		assert.isNotNull(request)
		const names = request!.resourceLogs.map(
			(resource) =>
				resource.resource.attributes.find((attr) => attr.key === "service.name")!.value.stringValue,
		)
		assert.includeMembers(names, ["railway:svc-unknown", "railway-environment:production"])
	})

	it("returns null for an empty batch", () => {
		assert.isNull(buildLogsExportRequest([], context))
	})
})
