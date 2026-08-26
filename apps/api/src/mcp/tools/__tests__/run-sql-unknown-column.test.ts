import { describe, expect, it } from "vitest"
import { withColumnListOnUnknownColumn } from "../run-sql"
import { McpQueryError } from "../types"

const err = (message: string) => new McpQueryError({ message, pipeName: "run_sql" })

// The exact production SQL: three invented columns on one rollup table.
const ROLLUP_SQL =
	"SELECT AttributeKey, sum(Count) AS c FROM attribute_keys_hourly WHERE $__orgFilter " +
	"AND $__timeFilter(Timestamp) AND ServiceName = 'enrichment-api' GROUP BY AttributeKey"

describe("withColumnListOnUnknownColumn", () => {
	it("appends the referenced table's real columns to an unknown-identifier error", () => {
		const enriched = withColumnListOnUnknownColumn(ROLLUP_SQL)(
			err("Unknown expression or function identifier 'Count' in scope SELECT AttributeKey, sum(Count)"),
		)
		expect(enriched.message).toContain("Unknown expression or function identifier 'Count'")
		expect(enriched.message).toContain("`attribute_keys_hourly`")
		expect(enriched.message).toContain("UsageCount")
		expect(enriched.message).toContain("Hour")
		// The absent dimension the agent kept guessing at must not be listed.
		expect(enriched.message).not.toContain("ServiceName")
	})

	it("matches the older Missing columns / no column wordings", () => {
		expect(
			withColumnListOnUnknownColumn(ROLLUP_SQL)(err("Missing columns: 'Timestamp'")).message,
		).toContain("UsageCount")
		expect(
			withColumnListOnUnknownColumn(ROLLUP_SQL)(err("There's no column 'Timestamp' in table")).message,
		).toContain("UsageCount")
	})

	// Errors that already carry an actionable message must not get a schema dump.
	it("leaves unrelated warehouse errors untouched", () => {
		const original = err("Memory limit (for query) exceeded")
		expect(withColumnListOnUnknownColumn(ROLLUP_SQL)(original)).toBe(original)
	})

	// Nothing useful to append when the query names no catalog table — that case
	// is `withTableListOnUnknownTable`'s.
	it("leaves the error untouched when no known table is referenced", () => {
		const original = err("Unknown identifier 'Count'")
		expect(withColumnListOnUnknownColumn("SELECT Count FROM otel_traces")(original)).toBe(original)
	})

	it("describes every referenced table in a join, capped at three", () => {
		const sql =
			"SELECT * FROM traces t JOIN logs l USING TraceId JOIN error_events e USING TraceId " +
			"JOIN service_usage u USING OrgId"
		const message = withColumnListOnUnknownColumn(sql)(err("Unknown identifier 'x'")).message
		expect(message).toContain("`traces`")
		expect(message).toContain("`logs`")
		expect(message).toContain("`error_events`")
		expect(message).not.toContain("`service_usage`")
	})

	it("preserves pipeName and cause", () => {
		const enriched = withColumnListOnUnknownColumn(ROLLUP_SQL)(
			new McpQueryError({
				message: "Unknown identifier 'Count'",
				pipeName: "run_sql",
				cause: new Error("boom"),
			}),
		)
		expect(enriched.pipeName).toBe("run_sql")
		expect(enriched.cause).toBeInstanceOf(Error)
	})

	// `cause` is an optionalKey on McpQueryError — rebuilding without one must not
	// materialise it as an explicit `undefined`.
	it("omits cause entirely when the original had none", () => {
		const enriched = withColumnListOnUnknownColumn(ROLLUP_SQL)(err("Unknown identifier 'Count'"))
		expect("cause" in enriched && enriched.cause !== undefined).toBe(false)
	})
})
