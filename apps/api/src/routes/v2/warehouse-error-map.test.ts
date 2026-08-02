import { describe, expect, it } from "@effect/vitest"
import {
	WAREHOUSE_ERROR_TAGS,
	WarehouseMalformedQueryError,
	WarehouseQuotaExceededError,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
	type WarehouseError,
} from "@maple/domain/http"
import {
	V2InvalidRequestError,
	V2RateLimitError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "@maple/domain/http/v2"
import { warehouseToV2 } from "./warehouse-error-map"

const map = warehouseToV2("trace_search")

describe("warehouseToV2", () => {
	it("maps a validation failure to a 400, not a 503", () => {
		const mapped = map(
			new WarehouseValidationError({ pipeName: "sqlQuery", message: "start_time is after end_time" }),
		)
		expect(mapped).toBeInstanceOf(V2InvalidRequestError)
		expect(mapped.error.message).toContain("start_time")
	})

	it("maps a quota breach to a 429, not a 503", () => {
		const mapped = map(
			new WarehouseQuotaExceededError({
				pipeName: "listTraces",
				message: "TIMEOUT_EXCEEDED",
				setting: "max_execution_time",
			}),
		)
		expect(mapped).toBeInstanceOf(V2RateLimitError)
	})

	it("keeps a genuine outage a 503 with the operation code", () => {
		const mapped = map(
			new WarehouseUpstreamError({ pipeName: "listTraces", message: "521 error", upstreamStatus: 521 }),
		)
		expect(mapped).toBeInstanceOf(V2ServiceUnavailableError)
		expect(mapped.error.code).toBe("trace_search_unavailable")
	})

	it("maps a Maple SQL bug to a 502 under its own code", () => {
		const mapped = map(
			new WarehouseMalformedQueryError({ pipeName: "traces_timeseries", message: "NO_COMMON_TYPE" }),
		)
		expect(mapped).toBeInstanceOf(V2UpstreamError)
		expect(mapped.error.code).toBe("warehouse_malformed_query")
		expect(mapped.error.message).toContain("our fault")
	})

	it("carries the schema-drift remediation instead of a fixed string", () => {
		const mapped = map(
			new WarehouseSchemaDriftError({ pipeName: "service_overview", message: "Unknown column SampleRate" }),
		)
		expect(mapped).toBeInstanceOf(V2UpstreamError)
		expect(mapped.error.code).toBe("warehouse_schema_drift")
		expect(mapped.error.message).toContain("schema apply")
	})

	it("handles every warehouse tag", () => {
		for (const tag of WAREHOUSE_ERROR_TAGS) {
			// Structural stand-in per tag; Match dispatches on _tag alone.
			const error = {
				_tag: tag,
				pipeName: "p",
				message: "boom",
				setting: "max_execution_time",
			} as unknown as WarehouseError
			expect(() => map(error), tag).not.toThrow()
		}
	})
})
