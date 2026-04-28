// ---------------------------------------------------------------------------
// Table Schema Definition
//
// A Table carries its name and column definitions at both the type level
// (for inference) and runtime (for SQL generation).
// ---------------------------------------------------------------------------

import type { ColumnDefs } from "./types"

export interface Table<Name extends string, Columns extends ColumnDefs> {
	readonly _tag: "Table"
	readonly name: Name
	readonly columns: Columns
}

export function table<const Name extends string, const Columns extends ColumnDefs>(
	name: Name,
	columns: Columns,
): Table<Name, Columns> {
	return { _tag: "Table", name, columns }
}
