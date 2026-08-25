import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { WarehouseDateTime, WarehouseTimeInput, warehouseDateTime } from "./datetime"

const decode = Schema.decodeUnknownResult(WarehouseTimeInput)
const ok = (input: string) => {
	const result = decode(input)
	expect(result._tag, `expected ${input} to decode`).toBe("Success")
	return result._tag === "Success" ? result.success : ""
}
const rejects = (input: string) => {
	expect(decode(input)._tag, `expected ${input} to be rejected`).toBe("Failure")
}

describe("WarehouseTimeInput", () => {
	it("canonicalizes every accepted encoding to the warehouse shape", () => {
		expect(ok("2026-03-30 14:30:00")).toBe("2026-03-30 14:30:00")
		expect(ok("2026-03-30T14:30:00Z")).toBe("2026-03-30 14:30:00")
		expect(ok("2026-03-30T14:30:00.123Z")).toBe("2026-03-30 14:30:00")
		expect(ok("2026-03-30 14:30:00.000")).toBe("2026-03-30 14:30:00")
		expect(ok("2026-03-30")).toBe("2026-03-30 00:00:00")
	})

	it("converts offsets to UTC", () => {
		expect(ok("2026-03-30T14:30:00+09:00")).toBe("2026-03-30 05:30:00")
		expect(ok("2026-03-30T14:30:00-05:00")).toBe("2026-03-30 19:30:00")
		expect(ok("2026-03-30T00:00:00+09:00")).toBe("2026-03-29 15:00:00")
	})

	// The value an investigation agent actually sent, which used to reach
	// ClickHouse as toDateTime('2026-08-47:53').
	it("rejects a sheared timestamp", () => {
		rejects("2026-08-47:53")
	})

	it("rejects structurally valid but impossible calendar instants", () => {
		rejects("2026-13-01 00:00:00")
		rejects("2026-00-01 00:00:00")
		rejects("2026-02-30 00:00:00")
		rejects("2026-04-31 00:00:00")
		rejects("2026-03-00 00:00:00")
		rejects("2026-03-30 25:00:00")
		rejects("2026-03-30 12:60:00")
		rejects("2026-03-30 12:00:61")
	})

	// Date.parse rolls 30 Feb over to 2 March rather than failing, so the
	// calendar fields are validated as written.
	it("handles leap years on both sides", () => {
		expect(ok("2024-02-29 00:00:00")).toBe("2024-02-29 00:00:00")
		expect(ok("2000-02-29 00:00:00")).toBe("2000-02-29 00:00:00")
		rejects("2026-02-29 00:00:00")
		rejects("1900-02-29 00:00:00")
	})

	// Each of these is accepted by Date.parse, which is why the grammar is
	// checked before parseability rather than instead of it.
	it("rejects the partials Date.parse would happily accept", () => {
		rejects("2026")
		rejects("Aug 25 2026")
		rejects("2026-03")
	})

	it("rejects non-timestamps", () => {
		rejects("not-a-date")
		rejects("")
		rejects("   ")
	})
})

describe("WarehouseDateTime", () => {
	it("accepts only the canonical shape", () => {
		const canonical = Schema.decodeUnknownResult(WarehouseDateTime)
		expect(canonical("2026-03-30 14:30:00")._tag).toBe("Success")
		// Already-canonical input is the only thing this brand admits — an ISO
		// string or a fractional part has to go through WarehouseTimeInput first.
		expect(canonical("2026-03-30T14:30:00Z")._tag).toBe("Failure")
		expect(canonical("2026-03-30 14:30:00.000")._tag).toBe("Failure")
	})
})

describe("warehouseDateTime", () => {
	it("mints the brand from epoch milliseconds", () => {
		expect(warehouseDateTime(Date.UTC(2026, 2, 30, 14, 30, 0))).toBe("2026-03-30 14:30:00")
	})

	it("truncates sub-second precision rather than emitting it", () => {
		expect(warehouseDateTime(Date.UTC(2026, 2, 30, 14, 30, 0) + 999)).toBe("2026-03-30 14:30:00")
	})
})
