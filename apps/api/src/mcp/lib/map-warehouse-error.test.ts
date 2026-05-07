import { describe, expect, it } from "vitest"
import { TinybirdQueryError } from "@maple/domain"
import { ObservabilityError } from "@maple/query-engine/observability"
import { toMcpQueryError } from "./map-warehouse-error"

describe("toMcpQueryError", () => {
	it("forwards plain query errors verbatim with the pipe label", () => {
		const err = new TinybirdQueryError({
			message: "boom",
			pipe: "service_overview",
			category: "query",
		})
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toBe("boom")
		expect(mcp.pipe).toBe("service_overview")
	})

	it("appends the schema-apply hint when the underlying error is schema_drift", () => {
		const err = new TinybirdQueryError({
			message:
				"Unknown expression or function identifier 'SampleRate' in scope SELECT ServiceName ...",
			pipe: "service_overview",
			category: "schema_drift",
			clickhouseType: "UNKNOWN_IDENTIFIER",
		})
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toContain("Unknown expression or function identifier 'SampleRate'")
		expect(mcp.message).toContain("schema apply")
		expect(mcp.message).toContain("/api/org-clickhouse-settings/apply-schema")
	})

	it("works for ObservabilityError once the executor forwards the category", () => {
		const err = new ObservabilityError({
			message: "Unknown identifier 'SampleRate'",
			pipe: "service_overview",
			category: "schema_drift",
		})
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toContain("schema apply")
	})

	it("does not enrich ObservabilityError when category is missing", () => {
		// Older code paths or non-warehouse errors won't carry a category;
		// the helper must pass through the raw message unchanged.
		const err = new ObservabilityError({ message: "boom", pipe: "service_overview" })
		const mcp = toMcpQueryError("service_overview")(err)
		expect(mcp.message).toBe("boom")
	})
})
