// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { assert, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

// This mock must be registered before importing its consumers.
const executeQueryEngineMock = vi.fn()
const runWarehouseQueryMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", async () => {
	const actual = await vi.importActual<typeof import("@/api/warehouse/effect-utils")>(
		"@/api/warehouse/effect-utils",
	)
	return {
		...actual,
		executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
		runWarehouseQuery: (...args: unknown[]) => runWarehouseQueryMock(...args),
	}
})

// Default mock implementations are (re)installed before each test so state
// does not leak between tests.
const defaultExecuteQueryEngine = (operation: string) => {
	if (operation.includes("listTraces")) {
		return Effect.succeed({
			result: {
				kind: "list",
				source: "traces",
				data: [
					{
						traceId: "t1",
						timestamp: "2026-03-28 00:00:00",
						durationMs: 142,
						serviceName: "api-gw",
						spanName: "GET /api/users",
						spanKind: "SERVER",
						statusCode: "Ok",
						hasError: 0,
						spanAttributes: {
							"http.method": "GET",
							"http.route": "/api/users",
							"http.status_code": "200",
						},
					},
				],
			},
		})
	}
	// Default: empty list
	return Effect.succeed({ result: { kind: "list", source: "traces", data: [] } })
}

const defaultRunWarehouseQuery = () =>
	Effect.succeed({
		data: [
			{
				timestamp: "2026-03-28 12:00:00",
				severityText: "ERROR",
				severityNumber: 17,
				serviceName: "api-gw",
				body: "Connection refused",
				traceId: "t1",
				spanId: "s1",
				logAttributes: '{"http.method":"GET"}',
				resourceAttributes: '{"service.version":"1.0"}',
			},
		],
	})

beforeEach(() => {
	executeQueryEngineMock.mockReset()
	executeQueryEngineMock.mockImplementation(defaultExecuteQueryEngine)
	runWarehouseQueryMock.mockReset()
	runWarehouseQueryMock.mockImplementation(defaultRunWarehouseQuery)
})

import { listTraces } from "@/api/warehouse/traces"
import { listLogs } from "@/api/warehouse/logs"
import { serverFunctionMap } from "@/components/dashboard-builder/data-source-registry"
import { resolveFieldPath } from "@/lib/resolve-field-path"

// 1. Verify listTraces works with exactly the params a list widget sends
describe("list widget data flow", () => {
	it.effect("listTraces succeeds with list widget params (no filter)", () =>
		Effect.gen(function* () {
			const params = {
				startTime: "2026-03-28 00:00:00",
				endTime: "2026-03-28 23:59:59",
				limit: 25,
			}

			const result = yield* listTraces({ data: params })

			assert.strictEqual(result.data.length, 1)
			expect(result.data[0]).toMatchObject({
				traceId: "t1",
				rootSpanName: "GET /api/users",
				durationMs: 142,
				hasError: false,
			})
		}),
	)

	it.effect("listTraces succeeds with filter params", () =>
		Effect.gen(function* () {
			const params = {
				startTime: "2026-03-28 00:00:00",
				endTime: "2026-03-28 23:59:59",
				limit: 50,
				service: "api-gw",
				hasError: true,
			}

			const result = yield* listTraces({ data: params })
			assert.isDefined(result.data)
		}),
	)

	it.effect("listLogs succeeds with list widget params", () =>
		Effect.gen(function* () {
			const params = {
				startTime: "2026-03-28 00:00:00",
				endTime: "2026-03-28 23:59:59",
				limit: 25,
			}

			const result = yield* listLogs({ data: params })

			assert.strictEqual(result.data.length, 1)
			expect(result.data[0]).toMatchObject({
				severityText: "ERROR",
				serviceName: "api-gw",
				body: "Connection refused",
				logAttributes: { "http.method": "GET" },
			})
		}),
	)

	// 2. Verify serverFunctionMap contains list endpoints
	it("serverFunctionMap has list_traces", () => {
		expect(serverFunctionMap.list_traces).toBeDefined()
		expect(typeof serverFunctionMap.list_traces).toBe("function")
	})

	it("serverFunctionMap has list_logs", () => {
		expect(serverFunctionMap.list_logs).toBeDefined()
		expect(typeof serverFunctionMap.list_logs).toBe("function")
	})

	// 3. Verify the full atom-like call path:
	//    serverFn({ data: params }) → response.data extraction
	it.effect("serverFunctionMap.list_traces({ data }) returns { data: Trace[] }", () =>
		Effect.gen(function* () {
			const serverFn = serverFunctionMap.list_traces
			const params = {
				startTime: "2026-03-28 00:00:00",
				endTime: "2026-03-28 23:59:59",
				limit: 25,
			}

			const response = yield* serverFn({ data: params }).pipe(
				Effect.map((res) => {
					// This is what widgetFetchAtom does:
					return (res as { data?: unknown })?.data ?? res
				}),
			)

			// After .data extraction, should be an array of Trace objects
			assert.isTrue(Array.isArray(response))
			const rows = response as Record<string, unknown>[]
			assert.isAbove(rows.length, 0)
			expect(rows[0]).toHaveProperty("traceId")
			expect(rows[0]).toHaveProperty("rootSpanName")
		}),
	)

	it.effect("serverFunctionMap.list_logs({ data }) returns { data: Log[] }", () =>
		Effect.gen(function* () {
			const serverFn = serverFunctionMap.list_logs
			const params = {
				startTime: "2026-03-28 00:00:00",
				endTime: "2026-03-28 23:59:59",
				limit: 25,
			}

			const response = yield* serverFn({ data: params }).pipe(
				Effect.map((res) => {
					return (res as { data?: unknown })?.data ?? res
				}),
			)

			assert.isTrue(Array.isArray(response))
			const rows = response as Record<string, unknown>[]
			assert.isAbove(rows.length, 0)
			expect(rows[0]).toHaveProperty("severityText")
			expect(rows[0]).toHaveProperty("serviceName")
		}),
	)
})

// 4. Simulate the exact widgetFetchAtom flow (JSON key roundtrip)
describe("widgetFetchAtom simulation", () => {
	function normalizeForKey(value: unknown): unknown {
		if (value === null || typeof value !== "object") return value
		if (Array.isArray(value)) return value.map(normalizeForKey)
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
		const out: Record<string, unknown> = {}
		for (const [k, v] of entries) out[k] = normalizeForKey(v)
		return out
	}
	function encodeKey(value: unknown): string {
		const n = normalizeForKey(value)
		return JSON.stringify(n === undefined ? null : n)
	}

	it.effect("list_traces: full atom roundtrip succeeds", () =>
		Effect.gen(function* () {
			// 1. Build params like useWidgetData does
			const resolvedTimeRange = { startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" }
			const widgetParams = { limit: 25 } // from list preset
			const resolvedParams: Record<string, unknown> = {
				startTime: resolvedTimeRange.startTime,
				endTime: resolvedTimeRange.endTime,
				...widgetParams,
			} satisfies Record<string, unknown>

			// 2. Encode key like widgetFetchAtom
			const key = encodeKey({ endpoint: "list_traces", params: resolvedParams })

			// 3. Parse key like atom does
			const { endpoint, params } = JSON.parse(key) as {
				endpoint: string
				params: Record<string, unknown>
			}

			assert.strictEqual(endpoint, "list_traces")
			assert.strictEqual(params.startTime, "2026-03-28 00:00:00")
			assert.strictEqual(params.endTime, "2026-03-28 23:59:59")
			assert.strictEqual(params.limit, 25)

			// 4. Call server function like atom does
			const serverFn = serverFunctionMap[endpoint as keyof typeof serverFunctionMap]
			assert.isDefined(serverFn)

			const result = yield* serverFn!({ data: params }).pipe(
				Effect.map((res) => (res as { data?: unknown })?.data ?? res),
			)

			assert.isTrue(Array.isArray(result))
			assert.isAbove((result as unknown[]).length, 0)
		}),
	)

	it.effect("list_logs: full atom roundtrip succeeds", () =>
		Effect.gen(function* () {
			const resolvedTimeRange = { startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" }
			const widgetParams = { limit: 25 }
			const resolvedParams: Record<string, unknown> = {
				startTime: resolvedTimeRange.startTime,
				endTime: resolvedTimeRange.endTime,
				...widgetParams,
			} satisfies Record<string, unknown>

			const key = encodeKey({ endpoint: "list_logs", params: resolvedParams })
			const { endpoint, params } = JSON.parse(key)
			const serverFn = serverFunctionMap[endpoint as keyof typeof serverFunctionMap]

			const result = yield* serverFn!({ data: params }).pipe(
				Effect.map((res) => (res as { data?: unknown })?.data ?? res),
			)

			assert.isTrue(Array.isArray(result))
			assert.isAbove((result as unknown[]).length, 0)
		}),
	)
})

// 5. Test buildWidgetDataSource for list
describe("buildWidgetDataSource for list", () => {
	// Import dynamically to avoid circular dependency issues
	it.effect("produces correct data source from list state", () =>
		Effect.gen(function* () {
			// Simulate what widget-query-builder-page does
			const {
				parseWhereClause,
				normalizeKey: normKey,
				parseBoolean: parseBool,
			} = yield* Effect.promise(() => import("@maple/domain/where-clause"))

			function buildListEndpointParams(
				dataSource: "traces" | "logs",
				whereClause: string,
				limit: number,
			): Record<string, unknown> {
				const { clauses } = parseWhereClause(whereClause)
				const params: Record<string, unknown> = { limit } satisfies Record<string, unknown>
				if (dataSource === "traces") {
					for (const clause of clauses) {
						const key = normKey(clause.key)
						if (key === "service.name") params.service = clause.value
						else if (key === "span.name") params.spanName = clause.value
						else if (key === "has_error") {
							const b = parseBool(clause.value)
							if (b != null) params.hasError = b
						}
					}
				} else {
					for (const clause of clauses) {
						const key = normKey(clause.key)
						if (key === "service.name") params.service = clause.value
						else if (key === "severity") params.severity = clause.value
					}
				}
				return params
			}

			// Test with empty where clause
			const params1 = buildListEndpointParams("traces", "", 50)
			assert.deepStrictEqual(params1, { limit: 50 })

			// Test with service filter
			const params2 = buildListEndpointParams("traces", 'service.name = "api-gw"', 25)
			assert.deepStrictEqual(params2, { limit: 25, service: "api-gw" })

			// Test with has_error filter
			const params3 = buildListEndpointParams("traces", "has_error = true", 25)
			assert.deepStrictEqual(params3, { limit: 25, hasError: true })

			// Test logs
			const params4 = buildListEndpointParams("logs", 'severity = "ERROR"', 50)
			assert.deepStrictEqual(params4, { limit: 50, severity: "ERROR" })

			// All of these should work with listTraces/listLogs
			for (const [fn, p] of [
				[
					serverFunctionMap.list_traces,
					{ ...params1, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
				],
				[
					serverFunctionMap.list_traces,
					{ ...params2, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
				],
				[
					serverFunctionMap.list_traces,
					{ ...params3, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
				],
				[
					serverFunctionMap.list_logs,
					{ ...params4, startTime: "2026-03-28 00:00:00", endTime: "2026-03-28 23:59:59" },
				],
			] as const) {
				const result = yield* fn({ data: p })
				expect(result).toHaveProperty("data")
			}
		}),
	)
})

// 6. resolveFieldPath tests
describe("resolveFieldPath", () => {
	const traceRow = {
		traceId: "t1",
		durationMs: 142,
		hasError: false,
		services: ["api-gw", "user-svc"],
		rootSpan: {
			name: "GET /api/users",
			kind: "SERVER",
			statusCode: "Ok",
			attributes: {
				"http.method": "GET",
				"http.route": "/api/users",
				"http.status_code": "200",
			},
		},
	}

	const logRow = {
		timestamp: "2026-03-28 12:00:00",
		severityText: "ERROR",
		serviceName: "api-gw",
		body: "Connection refused",
		logAttributes: { "http.method": "GET", "error.type": "ConnectionError" },
		resourceAttributes: { "service.version": "1.0", "deployment.environment": "prod" },
	}

	it("resolves top-level fields", () => {
		expect(resolveFieldPath(traceRow, "traceId")).toBe("t1")
		expect(resolveFieldPath(traceRow, "durationMs")).toBe(142)
		expect(resolveFieldPath(traceRow, "hasError")).toBe(false)
	})

	it("resolves nested object fields", () => {
		expect(resolveFieldPath(traceRow, "rootSpan.name")).toBe("GET /api/users")
		expect(resolveFieldPath(traceRow, "rootSpan.statusCode")).toBe("Ok")
	})

	it("resolves rootSpan.attributes with dotted keys", () => {
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.method")).toBe("GET")
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.route")).toBe("/api/users")
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.http.status_code")).toBe("200")
	})

	it("resolves logAttributes with dotted keys", () => {
		expect(resolveFieldPath(logRow, "logAttributes.http.method")).toBe("GET")
		expect(resolveFieldPath(logRow, "logAttributes.error.type")).toBe("ConnectionError")
	})

	it("resolves resourceAttributes with dotted keys", () => {
		expect(resolveFieldPath(logRow, "resourceAttributes.service.version")).toBe("1.0")
		expect(resolveFieldPath(logRow, "resourceAttributes.deployment.environment")).toBe("prod")
	})

	it("returns undefined for missing fields", () => {
		expect(resolveFieldPath(traceRow, "nonexistent")).toBeUndefined()
		expect(resolveFieldPath(traceRow, "rootSpan.attributes.nonexistent.key")).toBeUndefined()
		expect(resolveFieldPath(logRow, "logAttributes.nonexistent.key")).toBeUndefined()
	})

	it("resolves array fields", () => {
		expect(resolveFieldPath(traceRow, "services")).toEqual(["api-gw", "user-svc"])
	})
})
