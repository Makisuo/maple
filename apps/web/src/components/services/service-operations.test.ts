import { describe, expect, it } from "vitest"
import {
	callsPerSecond,
	operationTraceSearch,
	operationsBucketSeconds,
	serviceOperationsQueryInput,
	windowSeconds,
} from "./service-operations"

describe("windowSeconds", () => {
	it("computes the span of a warehouse-format window", () => {
		expect(windowSeconds("2024-01-01 00:00:00", "2024-01-01 01:00:00")).toBe(3600)
	})

	it("tolerates ISO timestamps", () => {
		expect(windowSeconds("2024-01-01T00:00:00Z", "2024-01-01T00:10:00Z")).toBe(600)
	})

	it("returns 0 for unparseable or inverted ranges", () => {
		expect(windowSeconds("garbage", "2024-01-01 01:00:00")).toBe(0)
		expect(windowSeconds("2024-01-01 02:00:00", "2024-01-01 01:00:00")).toBe(0)
	})
})

describe("operationsBucketSeconds", () => {
	it("targets ~50 buckets across the window", () => {
		expect(operationsBucketSeconds("2024-01-01 00:00:00", "2024-01-01 12:00:00")).toBe(864)
	})

	it("floors at one minute for short windows", () => {
		expect(operationsBucketSeconds("2024-01-01 00:00:00", "2024-01-01 00:15:00")).toBe(60)
	})
})

describe("callsPerSecond", () => {
	it("derives a rate from the estimated span count", () => {
		expect(callsPerSecond(7200, 3600)).toBe(2)
	})

	it("returns 0 for a degenerate window", () => {
		expect(callsPerSecond(100, 0)).toBe(0)
	})
})

describe("serviceOperationsQueryInput", () => {
	it("builds a stable atom key with bucket sizing and limit", () => {
		const input = serviceOperationsQueryInput({
			serviceName: "api",
			effectiveStartTime: "2024-01-01 00:00:00",
			effectiveEndTime: "2024-01-01 12:00:00",
			environments: ["production"],
		})
		expect(input).toEqual({
			serviceName: "api",
			startTime: "2024-01-01 00:00:00",
			endTime: "2024-01-01 12:00:00",
			environments: ["production"],
			bucketSeconds: 864,
			limit: 25,
		})
	})

	it("omits an empty environments filter", () => {
		const input = serviceOperationsQueryInput({
			serviceName: "api",
			effectiveStartTime: "2024-01-01 00:00:00",
			effectiveEndTime: "2024-01-01 01:00:00",
			environments: [],
		})
		expect(input.environments).toBeUndefined()
	})
})

describe("operationTraceSearch", () => {
	it("builds the structured /traces drill-down filters", () => {
		expect(
			operationTraceSearch({
				serviceName: "api",
				spanName: "GET /users",
				environments: ["production"],
				timePreset: "12h",
			}),
		).toEqual({
			services: ["api"],
			spanNames: ["GET /users"],
			deploymentEnvs: ["production"],
			rootOnly: false,
			startTime: undefined,
			endTime: undefined,
			timePreset: "12h",
		})
	})
})
