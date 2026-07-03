import { describe, expect, it } from "vitest"

import { getCloudPlatform, outcomeBadgeStyle } from "../cloud-platforms"

// Real attribute set captured from a live maple-chat-flue span via the Maple MCP
// (`inspect_span`, scope.name=workers-observability).
const FLUE_SPAN_ATTRS: Record<string, string> = {
	"cloud.platform": "cloudflare.workers",
	"cloud.provider": "cloudflare",
	"cloudflare.asn": "396982",
	"cloudflare.colo": "ORD",
	"cloudflare.execution_model": "stateless",
	"cloudflare.handler_type": "fetch",
	"cloudflare.invocation.sequence.number": "1",
	"cloudflare.outcome": "ok",
	"cloudflare.ray_id": "a10b37549bc02339",
	"cloudflare.response.time_to_first_byte_ms": "326",
	"cloudflare.script_name": "maple-chat-flue",
	"cloudflare.script_version.id": "98441fd6-a553-4e12-8f02-3b42a4b85809",
	cpu_time_ms: "4",
	"faas.invoked_region": "ENAM",
	"faas.name": "maple-chat-flue",
	"faas.trigger": "http",
	"faas.version": "98441fd6-a553-4e12-8f02-3b42a4b85809",
	"geo.country.code": "US",
	"geo.locality.name": "Council Bluffs",
	wall_time_ms: "4",
}

describe("getCloudPlatform — cloudflare", () => {
	it("normalizes a real Flue span", () => {
		const info = getCloudPlatform(FLUE_SPAN_ATTRS)
		expect(info).not.toBeNull()
		expect(info!.id).toBe("cloudflare")
		expect(info!.label).toBe("Cloudflare Worker")
		expect(info!.kind).toBe("Worker")
		expect(info!.edge).toBe("ORD · ENAM")
		expect(info!.location).toBe("Council Bluffs, US")
		expect(info!.outcome).toEqual({ value: "ok", bad: false })
	})

	it("exposes provider details as ordered fields, with copy/wide flags", () => {
		const fields = getCloudPlatform(FLUE_SPAN_ATTRS)!.fields
		const byLabel = Object.fromEntries(fields.map((f) => [f.label, f]))
		expect(byLabel["Script"]?.value).toBe("maple-chat-flue")
		expect(byLabel["Version"]).toMatchObject({ display: "98441fd6", copyable: true })
		expect(byLabel["CPU / Wall"]?.value).toBe("4ms / 4ms")
		expect(byLabel["TTFB"]?.value).toBe("326ms")
		expect(byLabel["Ray ID"]).toMatchObject({ value: "a10b37549bc02339", copyable: true, wide: true })
	})

	it("flags a non-ok outcome as bad", () => {
		const info = getCloudPlatform({ ...FLUE_SPAN_ATTRS, "cloudflare.outcome": "exceededCpu" })
		expect(info!.outcome).toEqual({ value: "exceededCpu", bad: true })
	})

	it("detects a Worker via cloud.platform alone (no edge attrs)", () => {
		const info = getCloudPlatform({ "cloud.platform": "cloudflare.workers" })
		expect(info?.id).toBe("cloudflare")
		expect(info?.edge).toBeNull()
		expect(info?.location).toBeNull()
		expect(info?.fields).toHaveLength(0)
	})

	it("falls back to faas.* when cloudflare.* identity keys are absent", () => {
		const info = getCloudPlatform({
			"cloud.platform": "cloudflare.workers",
			"faas.name": "my-worker",
			"faas.version": "v2",
			"faas.trigger": "queue",
		})
		const byLabel = Object.fromEntries(info!.fields.map((f) => [f.label, f.value]))
		expect(byLabel["Script"]).toBe("my-worker")
		expect(byLabel["Version"]).toBe("v2")
		expect(byLabel["Handler"]).toBe("queue")
	})

	it("returns null for a non-platform span (no cloud, no db)", () => {
		expect(
			getCloudPlatform({
				"http.method": "GET",
				"http.route": "/v1/spans",
			}),
		).toBeNull()
	})

	// Regression: the trimmed hierarchy projection (buildProjectedMapExpr) emits
	// the requested cloudflare.* KEYS with empty-string values on every span.
	// Detection must ignore empty values, or every span gets flagged as a Worker.
	it("returns null when cloudflare.* keys are present but empty (projected map)", () => {
		expect(
			getCloudPlatform({
				"cloud.platform": "",
				"cloudflare.colo": "",
				"cloudflare.outcome": "",
				"faas.invoked_region": "",
				"http.route": "/checkout",
			}),
		).toBeNull()
	})
})

describe("getCloudPlatform — database", () => {
	it("normalizes a DB-client span and humanizes db.system.name", () => {
		const info = getCloudPlatform({
			"db.system.name": "postgresql",
			"db.namespace": "app",
			"db.collection.name": "users",
			"db.operation.name": "SELECT",
			"db.response.returned_rows": "42",
			"server.address": "db.internal",
			"server.port": "5432",
		})
		expect(info?.id).toBe("database")
		expect(info?.label).toBe("PostgreSQL")
		expect(info?.outcome).toBeNull()
		const byLabel = Object.fromEntries(info!.fields.map((f) => [f.label, f.value]))
		expect(byLabel["Operation"]).toBe("SELECT")
		expect(byLabel["Namespace"]).toBe("app")
		expect(byLabel["Table"]).toBe("users")
		expect(byLabel["Rows returned"]).toBe("42")
		expect(byLabel["Server"]).toBe("db.internal:5432")
	})

	it("falls back to the legacy db.system and title-cases unknown systems", () => {
		expect(getCloudPlatform({ "db.system": "clickhouse" })?.label).toBe("ClickHouse")
		expect(getCloudPlatform({ "db.system.name": "microsoft.sql_server" })?.label).toBe("SQL Server")
		expect(getCloudPlatform({ "db.system.name": "cockroachdb" })?.label).toBe("CockroachDB")
	})

	it("flags error.type as a bad outcome", () => {
		const info = getCloudPlatform({ "db.system.name": "mysql", "error.type": "timeout" })
		expect(info?.outcome).toEqual({ value: "timeout", bad: true })
	})

	// Same projected-map regression as cloudflare: an empty db.system value must
	// not flag every span as a database call.
	it("returns null when db.system keys are present but empty (projected map)", () => {
		expect(
			getCloudPlatform({ "db.system.name": "", "db.system": "", "http.route": "/checkout" }),
		).toBeNull()
	})
})

describe("outcomeBadgeStyle", () => {
	it("styles ok vs failure outcomes differently", () => {
		expect(outcomeBadgeStyle(false)).toContain("severity-info")
		expect(outcomeBadgeStyle(true)).toContain("severity-error")
	})
})
