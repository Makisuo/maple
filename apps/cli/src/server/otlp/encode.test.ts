import { describe, expect, it } from "vitest"
import insertMappings from "../schema/local-inserts.json"
import {
	anyValueString,
	bytesHex,
	encodeLogs,
	encodeMetrics,
	encodeTraces,
	formatTimestampNano,
	statusCode,
} from "./encode"
import { decodeMetricsRequest, decodeTraceRequest, encodeMetricsRequest, encodeTraceRequest } from "./proto"

// Field-name set per datasource, parsed from the generated inputSchema string.
// "start_time DateTime64(9), trace_id String, …" → { start_time, trace_id, … }
const schemaFields = (datasource: string): Set<string> => {
	const ds = (insertMappings as { datasources: Record<string, { inputSchema: string }> }).datasources[
		datasource
	]!
	const fields = new Set<string>()
	// Split top-level commas only (types like Map(K, V) / Array(…) contain commas).
	let depth = 0
	let token = ""
	for (const ch of ds.inputSchema) {
		if (ch === "(") depth++
		else if (ch === ")") depth--
		if (ch === "," && depth === 0) {
			fields.add(token.trim().split(/\s+/)[0]!)
			token = ""
		} else token += ch
	}
	if (token.trim()) fields.add(token.trim().split(/\s+/)[0]!)
	return fields
}

const hex = "0af7651916cd43dd8448eb211c80319c"
const b64 = (h: string): string => Buffer.from(h, "hex").toString("base64")
// Captured from an OpenTelemetry Java agent OTLP/HTTP `POST /v1/traces`
// request. `protobufjs` 7.6.x throws `index out of range` on this payload,
// while newer releases decode it successfully.
const javaAgentTracePayloadB64 =
	"CvULCqUICiUKG2RlcGxveW1lbnQuZW52aXJvbm1lbnQubmFtZRIGCgR0ZXN0ChYKCWhvc3QuYXJjaBIJCgdhYXJjaDY0CisKCWhvc3QubmFtZRIeChx6aGFvamlydWlkZU1hY0Jvb2stQWlyLmxvY2FsCiMKDm9zLmRlc2NyaXB0aW9uEhEKD01hYyBPUyBYIDI2LjQuMQoTCgdvcy50eXBlEggKBmRhcndpbgoWCgpvcy52ZXJzaW9uEggKBjI2LjQuMQqgAQoUcHJvY2Vzcy5jb21tYW5kX2FyZ3MShwEqhAEKVQpTL1VzZXJzL3poYW9qaXJ1aS9MaWJyYXJ5L0phdmEvSmF2YVZpcnR1YWxNYWNoaW5lcy9vcGVuamRrLTIzL0NvbnRlbnRzL0hvbWUvYmluL2phdmEKKwopL3RtcC9tYXBsZS1qYXZhLWFnZW50LTdLMHcvT3RlbFJlcHJvLmphdmEKcAoXcHJvY2Vzcy5leGVjdXRhYmxlLnBhdGgSVQpTL1VzZXJzL3poYW9qaXJ1aS9MaWJyYXJ5L0phdmEvSmF2YVZpcnR1YWxNYWNoaW5lcy9vcGVuamRrLTIzL0NvbnRlbnRzL0hvbWUvYmluL2phdmEKEwoLcHJvY2Vzcy5waWQSBBjtpQIKVwobcHJvY2Vzcy5ydW50aW1lLmRlc2NyaXB0aW9uEjgKNk9yYWNsZSBDb3Jwb3JhdGlvbiBPcGVuSkRLIDY0LUJpdCBTZXJ2ZXIgVk0gMjMrMzctMjM2OQo1ChRwcm9jZXNzLnJ1bnRpbWUubmFtZRIdChtPcGVuSkRLIFJ1bnRpbWUgRW52aXJvbm1lbnQKJwoXcHJvY2Vzcy5ydW50aW1lLnZlcnNpb24SDAoKMjMrMzctMjM2OQo9ChNzZXJ2aWNlLmluc3RhbmNlLmlkEiYKJGQxZTI5NjA0LTI5ODYtNDlmZC1iNWJiLWU0ZjFhN2Q0ZjkyYwohCgxzZXJ2aWNlLm5hbWUSEQoPd2lzY2hvaWNlci11c2VyCj0KFXRlbGVtZXRyeS5kaXN0cm8ubmFtZRIkCiJvcGVudGVsZW1ldHJ5LWphdmEtaW5zdHJ1bWVudGF0aW9uCiQKGHRlbGVtZXRyeS5kaXN0cm8udmVyc2lvbhIICgYyLjI4LjEKIAoWdGVsZW1ldHJ5LnNkay5sYW5ndWFnZRIGCgRqYXZhCiUKEnRlbGVtZXRyeS5zZGsubmFtZRIPCg1vcGVudGVsZW1ldHJ5CiEKFXRlbGVtZXRyeS5zZGsudmVyc2lvbhIICgYxLjYyLjAKTwoXdmNzLnJlcG9zaXRvcnkudXJsLmZ1bGwSNAoyaHR0cHM6Ly9naXRodWIuY29tL1dpc2Nob2ljZXItWGlhbi93aXNjaG9pY2VyLXVzZXISoQMKMQohaW8ub3BlbnRlbGVtZXRyeS5qYXZhLWh0dHAtY2xpZW50EgwyLjI4LjEtYWxwaGESwgIKEGmLshO9k6DTrmM7fx2w70cSCD/XzWWx87T5KgNHRVQwAzkgsMwtvzK3GEEJ4tgtvzK3GEoVCgt0aHJlYWQubmFtZRIGCgRtYWluSi0KCHVybC5mdWxsEiEKH2h0dHA6Ly8xMjcuMC4wLjE6MTgwODEvcGluZz9pPTJKEwoLc2VydmVyLnBvcnQSBBihjQFKEwoKZXJyb3IudHlwZRIFCgM0MDRKHQoOc2VydmVyLmFkZHJlc3MSCwoJMTI3LjAuMC4xSiEKGG5ldHdvcmsucHJvdG9jb2wudmVyc2lvbhIFCgMxLjFKIAoZaHR0cC5yZXNwb25zZS5zdGF0dXNfY29kZRIDGJQDShwKE2h0dHAucmVxdWVzdC5tZXRob2QSBQoDR0VUSg8KCXRocmVhZC5pZBICGAF6AhgChQEDAQAAGidodHRwczovL29wZW50ZWxlbWV0cnkuaW8vc2NoZW1hcy8xLjM3LjAaJ2h0dHBzOi8vb3BlbnRlbGVtZXRyeS5pby9zY2hlbWFzLzEuMjQuMA=="

// Minimal ExportTraceServiceRequest encoded with the upstream OTLP schema.
// Span.flags is field 16, so its fixed32 key is the two-byte sequence 0x85 0x01.
const pythonSpanFlagsPayloadHex =
	"0a480a00124412420a1000000000000000000000000000000000120800000000000000002a0a776974682d666c6167733001390100000000000000410200000000000000850101000000"

const attr = (key: string, str: string) => ({ key, value: { stringValue: str } })

const sampleTraceReq = () => ({
	resourceSpans: [
		{
			resource: { attributes: [attr("service.name", "api"), attr("deployment.environment", "local")] },
			schemaUrl: "https://schema/resource",
			scopeSpans: [
				{
					scope: { name: "tracer", version: "1.2.3", attributes: [attr("scope.k", "v")] },
					schemaUrl: "https://schema/scope",
					spans: [
						{
							traceId: b64(hex),
							spanId: b64("b7ad6b7169203331"),
							parentSpanId: b64("0000000000000000"),
							traceState: "",
							name: "GET /users",
							kind: 2,
							startTimeUnixNano: "1700000000000000000",
							endTimeUnixNano: "1700000001500000000",
							attributes: [attr("http.method", "GET")],
							events: [
								{
									timeUnixNano: "1700000000500000000",
									name: "ev",
									attributes: [attr("a", "b")],
								},
							],
							links: [
								{
									traceId: b64(hex),
									spanId: b64("b7ad6b7169203331"),
									traceState: "",
									attributes: [attr("l", "1")],
								},
							],
							status: { code: 1, message: "" },
						},
					],
				},
			],
		},
	],
})

const sampleMetricsReq = () => {
	const common = { name: "m", description: "d", unit: "1" }
	const point = {
		attributes: [attr("k", "v")],
		startTimeUnixNano: "1700000000000000000",
		timeUnixNano: "1700000001000000000",
		exemplars: [
			{
				traceId: b64(hex),
				spanId: b64("b7ad6b7169203331"),
				timeUnixNano: "1700000000500000000",
				asDouble: 1.5,
				filteredAttributes: [attr("e", "1")],
			},
		],
		flags: 0,
	}
	return {
		resourceMetrics: [
			{
				resource: { attributes: [attr("service.name", "api")] },
				schemaUrl: "",
				scopeMetrics: [
					{
						scope: { name: "meter", version: "1" },
						schemaUrl: "",
						metrics: [
							{ ...common, gauge: { dataPoints: [{ ...point, asDouble: 3.14 }] } },
							{
								...common,
								sum: {
									dataPoints: [{ ...point, asInt: "42" }],
									aggregationTemporality: 2,
									isMonotonic: true,
								},
							},
							{
								...common,
								histogram: {
									dataPoints: [
										{
											...point,
											count: "10",
											sum: 5.5,
											bucketCounts: ["1", "2", "3"],
											explicitBounds: [1, 2],
											min: 0.1,
											max: 9.9,
										},
									],
									aggregationTemporality: 2,
								},
							},
							{
								...common,
								exponentialHistogram: {
									dataPoints: [
										{
											...point,
											count: "7",
											sum: 2.2,
											scale: 1,
											zeroCount: "0",
											positive: { offset: 0, bucketCounts: ["1", "2"] },
											negative: { offset: 0, bucketCounts: [] },
											min: 0,
											max: 1,
										},
									],
									aggregationTemporality: 1,
								},
							},
						],
					},
				],
			},
		],
	}
}

const sampleLogsReq = () => ({
	resourceLogs: [
		{
			resource: { attributes: [attr("service.name", "api")] },
			schemaUrl: "",
			scopeLogs: [
				{
					scope: { name: "logger" },
					schemaUrl: "",
					logRecords: [
						{
							timeUnixNano: "1700000000000000000",
							severityNumber: 9,
							severityText: "",
							body: { stringValue: "hello" },
							attributes: [attr("k", "v")],
							traceId: b64(hex),
							spanId: b64("b7ad6b7169203331"),
							flags: 1,
						},
					],
				},
			],
		},
	],
})

const keysOf = (batch: { ndjson: string }) => new Set(Object.keys(JSON.parse(batch.ndjson.split("\n")[0]!)))

describe("encoder output matches the chDB inputSchema", () => {
	it("traces row keys == traces inputSchema", () => {
		const [batch] = encodeTraces(sampleTraceReq())
		expect(batch!.datasource).toBe("traces")
		expect(keysOf(batch!)).toEqual(schemaFields("traces"))
	})

	it("logs row keys == logs inputSchema", () => {
		const [batch] = encodeLogs(sampleLogsReq())
		expect(keysOf(batch!)).toEqual(schemaFields("logs"))
	})

	it("each metric type's row keys == its inputSchema", () => {
		const batches = encodeMetrics(sampleMetricsReq())
		const byDs = new Map(batches.map((b) => [b.datasource, b]))
		for (const ds of [
			"metrics_gauge",
			"metrics_sum",
			"metrics_histogram",
			"metrics_exponential_histogram",
		]) {
			expect(byDs.has(ds), `missing datasource ${ds}`).toBe(true)
			expect(keysOf(byDs.get(ds)!), `keys for ${ds}`).toEqual(schemaFields(ds))
		}
	})
})

describe("value-level spot checks", () => {
	it("trace_id is lowercase hex; duration + status are correct", () => {
		const row = JSON.parse(encodeTraces(sampleTraceReq())[0]!.ndjson)
		expect(row.trace_id).toBe(hex)
		expect(row.parent_span_id).toBe("") // all-zero → empty
		expect(row.span_kind).toBe("Server")
		expect(row.status_code).toBe("Ok")
		expect(row.duration).toBe(1_500_000_000) // 1.5s in ns
		expect(row.start_time).toBe("2023-11-14 22:13:20.000000000")
		expect(row.span_attributes).toEqual({ "http.method": "GET" })
		expect(row.events_timestamp).toEqual(["2023-11-14 22:13:20.500000000"])
	})

	it("helpers behave like the Rust originals", () => {
		expect(bytesHex(b64(hex))).toBe(hex)
		expect(bytesHex(b64("0000000000000000"))).toBe("")
		expect(formatTimestampNano("0")).toBe("1970-01-01 00:00:00.000000000")
		expect(statusCode(2)).toBe("Error")
		expect(anyValueString({ boolValue: true })).toBe("true")
		expect(anyValueString({ intValue: "7" })).toBe("7")
		expect(anyValueString({ arrayValue: { values: [{ stringValue: "a" }, { intValue: 1 }] } })).toBe(
			'["a","1"]',
		)
	})
})

describe("protobuf round-trip (proves vendored .proto field numbers)", () => {
	it("traces: object → protobuf → decode → encode keeps the key-set invariant", () => {
		const bytes = encodeTraceRequest(sampleTraceReq())
		const decoded = decodeTraceRequest(bytes)
		const [batch] = encodeTraces(decoded)
		expect(keysOf(batch!)).toEqual(schemaFields("traces"))
		const row = JSON.parse(batch!.ndjson)
		expect(row.trace_id).toBe(hex)
		expect(row.service_name).toBe("api")
		expect(row.span_kind).toBe("Server")
	})

	it("metrics: object → protobuf → decode → encode preserves all four datasources", () => {
		const bytes = encodeMetricsRequest(sampleMetricsReq())
		const decoded = decodeMetricsRequest(bytes)
		const datasources = new Set(encodeMetrics(decoded).map((b) => b.datasource))
		expect(datasources).toEqual(
			new Set(["metrics_gauge", "metrics_sum", "metrics_histogram", "metrics_exponential_histogram"]),
		)
	})
})

describe("external OTLP protobuf compatibility", () => {
	it("decodes a non-zero fixed32 span flags field emitted by the Python SDK", () => {
		const decoded = decodeTraceRequest(Buffer.from(pythonSpanFlagsPayloadHex, "hex")) as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; flags: number }> }> }>
		}
		const span = decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0]
		expect(span).toMatchObject({ name: "with-flags", flags: 1 })

		const [batch] = encodeTraces(decoded)
		expect(batch).toMatchObject({ datasource: "traces", rowCount: 1 })
	})

	it("decodes a Java agent OTLP/HTTP traces payload captured from the wire", () => {
		const decoded = decodeTraceRequest(Buffer.from(javaAgentTracePayloadB64, "base64"))
		const [batch] = encodeTraces(decoded)
		expect(batch!.datasource).toBe("traces")
		expect(batch!.rowCount).toBe(1)
		const row = JSON.parse(batch!.ndjson)
		expect(row.service_name).toBe("wischoicer-user")
		expect(row.scope_name).toBe("io.opentelemetry.java-http-client")
		expect(row.span_kind).toBe("Client")
		expect(row.resource_attributes["deployment.environment.name"]).toBe("test")
		expect(row.span_attributes["url.full"]).toBe("http://127.0.0.1:18081/ping?i=2")
	})
})
