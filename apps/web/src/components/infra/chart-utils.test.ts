import { describe, expect, it } from "vitest"
import { formatSeconds, formatValueWithUnit, isoToLabel, makeBucketLabeler, transformRows } from "./chart-utils"

describe("formatValueWithUnit", () => {
	it("renders a percentage with a % sign", () => {
		expect(formatValueWithUnit(0.095, "percent")).toBe("9.5%")
		expect(formatValueWithUnit(0.5, "percent")).toBe("50%")
	})

	it("renders cores with a unit suffix (never a bare number)", () => {
		expect(formatValueWithUnit(0.067, "cores")).toBe("0.067 cores")
		expect(formatValueWithUnit(2, "cores")).toBe("2 cores")
	})

	it("renders a duration for seconds", () => {
		expect(formatValueWithUnit(45, "seconds")).toBe("45s")
		expect(formatValueWithUnit(3600, "seconds")).toBe("1h 0m")
	})

	it("renders load as a fixed-precision number", () => {
		expect(formatValueWithUnit(1.2, "load")).toBe("1.20")
	})

	it("renders bytes/second with a rate unit", () => {
		expect(formatValueWithUnit(2048, "bytes_per_second")).toBe("2.0 KB/s")
	})

	it("guards against non-finite values", () => {
		expect(formatValueWithUnit(Number.NaN, "cores")).toBe("—")
		expect(formatValueWithUnit(Number.POSITIVE_INFINITY, "percent")).toBe("—")
	})
})

describe("formatSeconds", () => {
	it("scales the unit with magnitude", () => {
		expect(formatSeconds(30)).toBe("30s")
		expect(formatSeconds(120)).toBe("2m")
		expect(formatSeconds(3 * 3600 + 20 * 60)).toBe("3h 20m")
		expect(formatSeconds(2 * 86400 + 4 * 3600)).toBe("2d 4h")
	})

	it("returns an em dash for non-positive/invalid input", () => {
		expect(formatSeconds(0)).toBe("—")
		expect(formatSeconds(-5)).toBe("—")
	})
})

describe("makeBucketLabeler", () => {
	it("uses plain time-of-day labels while the buckets span a single day", () => {
		const buckets = ["2026-07-03T10:00:00Z", "2026-07-03T22:00:00Z"]
		const label = makeBucketLabeler(buckets)
		expect(label(buckets[0]!)).toBe(isoToLabel(buckets[0]!))
		expect(label(buckets[0]!)).not.toMatch(/Jul/)
	})

	it("prefixes the date once the buckets cross 24h", () => {
		const buckets = ["2026-07-01T10:00:00Z", "2026-07-04T10:00:00Z"]
		const label = makeBucketLabeler(buckets)
		const iso = "2026-07-03T14:35:00Z"
		const expectedDate = new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
		expect(label(iso)).toBe(`${expectedDate}, ${isoToLabel(iso)}`)
	})

	it("falls back to time-of-day for empty or unparsable input", () => {
		expect(makeBucketLabeler([])("2026-07-03T14:35:00Z")).toBe(isoToLabel("2026-07-03T14:35:00Z"))
	})
})

describe("transformRows", () => {
	it("labels points with the provided labeler", () => {
		const rows = [
			{ bucket: "2026-07-01T10:00:00Z", attributeValue: "a", value: 1 },
			{ bucket: "2026-07-04T10:00:00Z", attributeValue: "a", value: 2 },
		]
		const { data } = transformRows(rows, makeBucketLabeler(rows.map((r) => r.bucket)))
		expect(data[0]?.time).toMatch(/^[A-Z][a-z]{2} \d{1,2}, /)
		expect(data[1]?.time).toMatch(/^[A-Z][a-z]{2} \d{1,2}, /)
		expect(data[0]?.time).not.toBe(data[1]?.time)
	})
})
