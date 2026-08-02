import { latestSnapshotStatements } from "@maple/domain/generated/clickhouse-schema"
import { describe, expect, it } from "vitest"

import * as Tables from "./tables"

// The DSL's table definitions are a hand-written mirror of the warehouse schema
// generated from packages/domain/src/tinybird/datasources.ts. Nothing used to
// test that mirror, so a column added on one side and forgotten on the other
// surfaced as a runtime "unknown column" 500 instead of a failing build — which
// is exactly how the session-analytics columns could have shipped broken.
//
// This is a *type* check, not a shape check: the mirror is allowed to cover only
// the columns the DSL queries (a table with 40 columns can be mirrored with 12),
// but every column it does declare has to exist upstream with a compatible type.

interface DdlTable {
	readonly name: string
	readonly columns: ReadonlyMap<string, string>
}

/**
 * Pull column name → type out of a `CREATE TABLE` statement. Nested types carry
 * commas and parens, so columns are split at depth 0 rather than on `,`.
 */
function parseDdl(statement: string): DdlTable | undefined {
	const header = /CREATE TABLE (?:IF NOT EXISTS )?(\w+) \(/.exec(statement)
	if (!header) return undefined
	const body = statement.slice(header.index + header[0].length)

	const columns = new Map<string, string>()
	let depth = 0
	let start = 0
	const lines: string[] = []
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]
		if (ch === "(") depth++
		else if (ch === ")") {
			if (depth === 0) {
				lines.push(body.slice(start, i))
				break
			}
			depth--
		} else if (ch === "," && depth === 0) {
			lines.push(body.slice(start, i))
			start = i + 1
		}
	}

	for (const line of lines) {
		const trimmed = line.trim()
		// Skip index definitions, which share the column list.
		if (!trimmed || trimmed.startsWith("INDEX ")) continue
		const match = /^(\w+)\s+(.+)$/s.exec(trimmed)
		if (!match) continue
		const [, name, rest] = match
		columns.set(name!, stripModifiers(rest!))
	}

	return { columns, name: header[1]! }
}

/** Drop `DEFAULT …`/`CODEC(…)` tails, leaving the bare type expression. */
function stripModifiers(type: string): string {
	let depth = 0
	for (let i = 0; i < type.length; i++) {
		const ch = type[i]
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (depth === 0 && type.startsWith(" DEFAULT ", i)) return type.slice(0, i)
		else if (depth === 0 && type.startsWith(" CODEC(", i)) return type.slice(0, i)
	}
	return type.trim()
}

/**
 * Reduce a ClickHouse type to the tag the DSL descriptors carry. `LowCardinality`
 * and the aggregate wrappers are storage details the DSL doesn't model, so they
 * resolve to the type they wrap; `Nullable`, `Map` and `Array` are their own tags
 * because the DSL models them.
 */
function tagOf(type: string): string {
	const inner = /^LowCardinality\((.+)\)$/s.exec(type)
	if (inner) return tagOf(inner[1]!)
	const aggregate = /^SimpleAggregateFunction\(\w+,\s*(.+)\)$/s.exec(type)
	if (aggregate) return tagOf(aggregate[1]!)
	if (type.startsWith("AggregateFunction(")) return "AggregateFunction"
	if (type.startsWith("Nullable(")) return "Nullable"
	if (type.startsWith("Map(")) return "Map"
	if (type.startsWith("Array(")) return "Array"
	// DateTime64(9) → DateTime64, Decimal(9, 2) → Decimal.
	return type.replace(/\(.*$/s, "").trim()
}

const ddlByTable = new Map<string, DdlTable>()
for (const statement of latestSnapshotStatements) {
	const parsed = parseDdl(statement)
	if (parsed) ddlByTable.set(parsed.name, parsed)
}

interface MirroredTable {
	readonly name: string
	readonly columns: Record<string, { readonly _tag: string }>
}

const mirrored: MirroredTable[] = []
for (const value of Object.values(Tables)) {
	if (typeof value !== "object" || value === null) continue
	if (!("_tag" in value) || value._tag !== "Table") continue
	mirrored.push({ columns: value.columns, name: value.name })
}


describe("DSL table definitions mirror the warehouse schema", () => {
	it("covers every table the DSL declares (or knowingly skips it)", () => {
		// Views and tables the snapshot doesn't own would silently pass the
		// per-table checks below; assert the overlap is real so this suite can't
		// quietly degrade into testing nothing.
		const covered = mirrored.filter((table) => ddlByTable.has(table.name))
		expect(covered.length).toBeGreaterThan(0)
	})

	for (const table of mirrored) {
		const ddl = ddlByTable.get(table.name)
		if (!ddl) continue

		it(`${table.name}: no unknown or mistyped columns`, () => {
			const mismatches: string[] = []
			for (const [column, descriptor] of Object.entries(table.columns)) {
				const upstream = ddl.columns.get(column)
				if (upstream === undefined) {
					mismatches.push(`${column}: not in the warehouse schema`)
					continue
				}
				const expected = tagOf(upstream)
				// The DSL doesn't model aggregate state types; those columns are
				// declared as whatever the query reads them back as.
				if (expected === "AggregateFunction") continue
				if (expected !== descriptor._tag) {
					mismatches.push(`${column}: DSL says ${descriptor._tag}, warehouse says ${upstream}`)
				}
			}
			expect(mismatches).toEqual([])
		})
	}

	it("session_replays mirrors every column, so analytics dimensions can't be half-added", () => {
		// Stricter than the shared check above: this table is queried column-by-
		// column by the sessions UI, and the analytics columns landed in three
		// places at once (datasource, migration, mirror). Missing is as bad as
		// wrong here.
		const ddl = ddlByTable.get("session_replays")
		expect(ddl).toBeDefined()
		const missing = [...ddl!.columns.keys()].filter((column) => !(column in Tables.SessionReplays.columns))
		expect(missing).toEqual([])
	})
})
