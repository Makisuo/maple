import { describe, expect, it } from "vitest"
import { withTableListOnUnknownTable } from "../run-sql"
import { McpQueryError } from "../types"

const err = (message: string) => new McpQueryError({ message, pipeName: "run_sql" })

const errWithCause = (message: string) =>
	new McpQueryError({ message, pipeName: "run_sql", cause: new Error("boom") })

describe("withTableListOnUnknownTable", () => {
	// The exact production failure: 8 hits on a table the agent invented, answered
	// with a message that never said what the real tables are.
	it("appends the table list to a Tinybird resource-not-found error", () => {
		const enriched = withTableListOnUnknownTable(err("Resource 'otel_traces' not found"))
		expect(enriched.message).toContain("Resource 'otel_traces' not found")
		expect(enriched.message).toContain("Available tables:")
		expect(enriched.message).toContain("traces")
		expect(enriched.message).toContain("error_events")
	})

	it("appends the table list to a ClickHouse unknown-table error", () => {
		expect(withTableListOnUnknownTable(err("Unknown table maple.foo")).message).toContain(
			"Available tables:",
		)
		expect(
			withTableListOnUnknownTable(err("Table maple.foo does not exist")).message,
		).toContain("Available tables:")
	})

	// Every other warehouse failure already carries a message the agent can act on;
	// dumping 38 table names onto a timeout would only bury it.
	it("leaves unrelated warehouse errors untouched", () => {
		const original = err("Memory limit (for query) exceeded")
		expect(withTableListOnUnknownTable(original)).toBe(original)
	})

	it("does not mistake a missing COLUMN for a missing table", () => {
		const original = err("Missing columns: 't.OrgId'")
		expect(withTableListOnUnknownTable(original)).toBe(original)
	})

	it("preserves pipeName and cause", () => {
		const enriched = withTableListOnUnknownTable(errWithCause("Unknown table x"))
		expect(enriched.pipeName).toBe("run_sql")
		expect(enriched.cause).toBeInstanceOf(Error)
	})

	// `cause` is an optionalKey on McpQueryError — rebuilding without one must not
	// materialise it as an explicit `undefined`.
	it("omits cause entirely when the original had none", () => {
		const enriched = withTableListOnUnknownTable(err("Unknown table x"))
		expect("cause" in enriched && enriched.cause !== undefined).toBe(false)
	})
})
