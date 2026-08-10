import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { beforeEach, expect, vi } from "vitest"

const executeQueryEngineMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", async () => {
	const actual = await vi.importActual<typeof import("@/api/warehouse/effect-utils")>(
		"@/api/warehouse/effect-utils",
	)
	return {
		...actual,
		executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	}
})

import { getTracesDurationStats, getTracesFacets, listTraces } from "@/api/warehouse/traces"

describe("tinybird traces attribute filter params", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		executeQueryEngineMock.mockImplementation((operation: string) => {
			if (operation.includes("Facets")) {
				return Effect.succeed({ result: { kind: "facets", source: "traces", data: [] } })
			}
			if (operation.includes("DurationStats") || operation.includes("Stats")) {
				return Effect.succeed({
					result: {
						kind: "stats",
						source: "traces",
						data: { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 },
					},
				})
			}
			return Effect.succeed({ result: { kind: "list", source: "traces", data: [] } })
		})
	})

	it.effect("forwards basic filter params to list_traces", () =>
		Effect.gen(function* () {
			yield* listTraces({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			expect(executeQueryEngineMock).toHaveBeenCalledWith(
				"queryEngine.listTraces",
				expect.objectContaining({
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
					query: expect.objectContaining({
						columns: expect.arrayContaining(["services"]),
					}),
				}),
			)
		}),
	)

	it.effect("forwards filter params to traces_facets and traces_duration_stats", () =>
		Effect.gen(function* () {
			yield* getTracesFacets({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			expect(executeQueryEngineMock).toHaveBeenCalledWith(
				"queryEngine.getTracesFacets",
				expect.objectContaining({
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				}),
			)
			expect(executeQueryEngineMock).toHaveBeenCalledWith(
				"queryEngine.getTracesDurationStats",
				expect.objectContaining({
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				}),
			)
		}),
	)

	it.effect("forwards filter params to standalone traces_duration_stats", () =>
		Effect.gen(function* () {
			yield* getTracesDurationStats({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			expect(executeQueryEngineMock).toHaveBeenCalledWith(
				"queryEngine.getTracesDurationStats",
				expect.objectContaining({
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				}),
			)
		}),
	)

	it.effect("builds a curated rootSpan summary for overview rows", () =>
		Effect.gen(function* () {
			executeQueryEngineMock.mockReturnValueOnce(
				Effect.succeed({
					result: {
						kind: "list",
						source: "traces",
						data: [
							{
								traceId: "trace-1",
								timestamp: "2026-02-01 00:00:00",
								durationMs: 2000,
								serviceName: "checkout",
								services: ["gateway", "checkout", "payments"],
								spanName: "GET",
								spanKind: "SPAN_KIND_SERVER",
								statusCode: "Ok",
								hasError: 0,
								spanAttributes: {
									"http.method": "GET",
									"http.route": "/checkout",
									"http.status_code": "200",
								},
							},
						],
					},
				}),
			)

			const response = yield* listTraces({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			expect(response.data[0]).toMatchObject({
				services: ["gateway", "checkout", "payments"],
				rootSpanName: "GET",
				rootSpan: {
					name: "GET",
					kind: "SPAN_KIND_SERVER",
					statusCode: "Ok",
					attributes: {
						"http.method": "GET",
						"http.route": "/checkout",
						"http.status_code": "200",
					},
					http: {
						method: "GET",
						route: "/checkout",
						statusCode: 200,
						isError: false,
					},
				},
			})
		}),
	)
})
