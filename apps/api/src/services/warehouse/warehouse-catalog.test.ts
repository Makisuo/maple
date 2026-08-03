import { describe, expect, it } from "vitest"
import { describeWarehouseTable, listWarehouseTables } from "./warehouse-catalog"

describe("listWarehouseTables", () => {
	it("includes the canonical maple tables", () => {
		const names = listWarehouseTables().map((t) => t.name)
		expect(names).toContain("logs")
		expect(names).toContain("traces")
		expect(names).toContain("service_overview_spans")
		expect(names).toContain("error_spans")
		expect(names).toContain("metrics_gauge")
	})

	it("returns descriptions", () => {
		const logs = listWarehouseTables().find((t) => t.name === "logs")
		expect(logs?.description).toBeTruthy()
	})
})

describe("describeWarehouseTable", () => {
	it("returns null for unknown tables", () => {
		expect(describeWarehouseTable("does_not_exist")).toBeNull()
	})

	it("describes `logs` with its key columns", () => {
		const info = describeWarehouseTable("logs")
		expect(info).not.toBeNull()
		const names = info!.columns.map((c) => c.name)
		expect(names).toContain("OrgId")
		expect(names).toContain("Timestamp")
		expect(names).toContain("ServiceName")
		expect(names).toContain("SeverityText")
		expect(names).toContain("LogAttributes")
	})

	it("emits ClickHouse type strings (LowCardinality, Map, DateTime64)", () => {
		const info = describeWarehouseTable("logs")
		const orgId = info!.columns.find((c) => c.name === "OrgId")
		expect(orgId?.type).toBe("LowCardinality(String)")
		const ts = info!.columns.find((c) => c.name === "Timestamp")
		expect(ts?.type).toMatch(/DateTime/)
		const attrs = info!.columns.find((c) => c.name === "LogAttributes")
		expect(attrs?.type).toMatch(/^Map\(/)
	})

	it("includes hand-curated notes", () => {
		const traces = describeWarehouseTable("traces")
		expect(traces?.notes?.some((n) => n.includes("Title Case"))).toBe(true)
		expect(traces?.notes?.some((n) => n.toLowerCase().includes("nanosecond"))).toBe(true)
	})

	it("exposes the sorting key", () => {
		const sos = describeWarehouseTable("service_overview_spans")
		const key = Array.isArray(sos?.sortingKey)
			? (sos!.sortingKey as ReadonlyArray<string>).join(",")
			: String(sos?.sortingKey ?? "")
		expect(key).toContain("OrgId")
		expect(key).toContain("ServiceName")
		expect(key).toContain("Timestamp")
	})
})
