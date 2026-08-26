import { __testables } from "@/services/warehouse/WarehouseQueryService"
import { makeLargeTraceSpans, makeTraceLogs } from "./fixtures"

export interface FixtureRule {
	/** Match against the compiled SQL the WarehouseQueryService would execute. */
	readonly match: (sql: string) => boolean
	readonly rows: ReadonlyArray<unknown>
}

/**
 * Default fixtures for the large-trace `inspect_trace` scenario. Both the
 * `span_hierarchy` and `list_logs` pipes compile to SQL referencing their CH
 * table, so we route by table name.
 */
const defaultTraceFixtures = (): FixtureRule[] => [
	{ match: (sql) => sql.includes("trace_detail_spans"), rows: makeLargeTraceSpans() },
	{ match: (sql) => /\bfrom\s+logs\b/i.test(sql), rows: makeTraceLogs() },
]

/**
 * Replace the warehouse SQL client with a fake that answers from fixtures. The
 * REAL WarehouseQueryService still runs (OrgId enforcement, CH-DSL compile,
 * pipe-dispatch, row parsing) — only the wire call is faked. Unmatched SQL
 * throws loudly so missing fixtures never look like an empty result.
 */
export const installFakeWarehouse = (rules: FixtureRule[] = defaultTraceFixtures()): void => {
	__testables.setClientFactory(() => ({
		sql: async (statement) => {
			const sql = statement.text
			const rule = rules.find((r) => r.match(sql))
			if (!rule) {
				throw new Error(`[eval fake warehouse] no fixture matched SQL:\n${sql.slice(0, 600)}`)
			}
			return { data: rule.rows as ReadonlyArray<Record<string, unknown>> }
		},
		insert: async () => {},
	}))
}

export const restoreWarehouse = (): void => __testables.reset()
