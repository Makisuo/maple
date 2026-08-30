// Table Schema Definition
//
// A Table carries its name and column definitions at both the type level
// (for inference) and runtime (for SQL generation).

import type { ColumnDefs } from "./types"

export interface Table<Name extends string, Columns extends ColumnDefs> {
	readonly _tag: "Table"
	readonly name: Name
	readonly columns: Columns
	/**
	 * The column carrying row-level tenancy, when the schema has one. An
	 * equality or membership test on it marks a query as tenant-scoped
	 * (`CompiledQuery.tenantScope`); a table without one never scopes anything,
	 * so every query over it compiles as `"cross-tenant"`.
	 *
	 * Widened to `string` here on purpose: `TableOptions` checks the name
	 * against the declared columns where the table is defined, and keeping that
	 * narrowing on the interface would make a `Table` with more columns fail to
	 * satisfy a `Table` type declared with fewer.
	 */
	readonly tenantColumn?: string
}

export interface TableOptions<Columns extends ColumnDefs> {
	readonly tenantColumn?: keyof Columns & string
}

export function table<const Name extends string, const Columns extends ColumnDefs>(
	name: Name,
	columns: Columns,
	options?: TableOptions<Columns>,
): Table<Name, Columns> {
	return {
		_tag: "Table",
		name,
		columns,
		...(options?.tenantColumn !== undefined ? { tenantColumn: options.tenantColumn } : undefined),
	}
}
