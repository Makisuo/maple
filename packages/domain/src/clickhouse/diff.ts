/**
 * Pure schema-diff logic for self-managed ClickHouse drift detection.
 *
 * "Desired" is what Maple ships in its bundled snapshot (`migrations[0]`);
 * "actual" is what we read from the customer's `system.columns` /
 * `system.tables`. The diff is computed locally with no I/O so it can be
 * unit-tested with simple fixtures.
 *
 * Status semantics:
 *   - `up_to_date`: table exists and every desired column matches by type.
 *     Extra columns in the customer's table do NOT downgrade the status —
 *     extras are surfaced separately for visibility, but Maple's queries only
 *     care that the columns it reads from exist with the right types.
 *
 *   - `missing`:    table doesn't exist on the cluster. Apply will create it.
 *
 *   - `drifted`:    table exists but at least one desired column is missing or
 *     has a type mismatch. Apply will SKIP these (auto-remediation is out of
 *     scope for v1).
 *
 * For materialized views v1 only checks existence — comparing MV bodies would
 * require parsing CH's `system.tables.create_table_query` output and we don't
 * yet have a good story for handling whitespace / formatting differences.
 */

export type ClickHouseTableKind = "table" | "materialized_view"

export interface DesiredTable {
	readonly name: string
	readonly kind: ClickHouseTableKind
	readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>
	/** The original CREATE statement, used by the apply path for missing tables/MVs. */
	readonly createStatement: string
}

export interface DesiredSchema {
	readonly tables: ReadonlyArray<DesiredTable>
}

export interface ActualTable {
	readonly name: string
	readonly kind: ClickHouseTableKind
	readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>
}

export type ColumnDrift =
	| { readonly kind: "missing"; readonly column: string; readonly expectedType: string }
	| { readonly kind: "extra"; readonly column: string; readonly actualType: string }
	| {
			readonly kind: "type_mismatch"
			readonly column: string
			readonly expectedType: string
			readonly actualType: string
	  }

export type TableDiffEntry =
	| { readonly status: "up_to_date"; readonly name: string; readonly kind: ClickHouseTableKind }
	| { readonly status: "missing"; readonly name: string; readonly kind: ClickHouseTableKind }
	| {
			readonly status: "drifted"
			readonly name: string
			readonly kind: ClickHouseTableKind
			readonly columnDrifts: ReadonlyArray<ColumnDrift>
	  }
	| {
			readonly status: "wrong_kind"
			readonly name: string
			readonly kind: ClickHouseTableKind
			readonly actualKind: ClickHouseTableKind
	  }

const normalizeType = (type: string): string =>
	// Collapse whitespace; CH's system.columns sometimes returns the type with
	// or without spaces after commas in nested types, depending on version.
	type.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim()

const diffColumns = (
	desired: DesiredTable,
	actual: ActualTable,
): ReadonlyArray<ColumnDrift> => {
	const drifts: ColumnDrift[] = []
	const desiredByName = new Map(desired.columns.map((c) => [c.name, c]))
	const actualByName = new Map(actual.columns.map((c) => [c.name, c]))

	for (const expected of desired.columns) {
		const actualCol = actualByName.get(expected.name)
		if (!actualCol) {
			drifts.push({
				kind: "missing",
				column: expected.name,
				expectedType: expected.type,
			})
			continue
		}
		if (normalizeType(actualCol.type) !== normalizeType(expected.type)) {
			drifts.push({
				kind: "type_mismatch",
				column: expected.name,
				expectedType: expected.type,
				actualType: actualCol.type,
			})
		}
	}

	for (const actualCol of actual.columns) {
		if (!desiredByName.has(actualCol.name)) {
			drifts.push({
				kind: "extra",
				column: actualCol.name,
				actualType: actualCol.type,
			})
		}
	}

	return drifts
}

export const computeSchemaDiff = (
	desired: DesiredSchema,
	actual: ReadonlyMap<string, ActualTable>,
): ReadonlyArray<TableDiffEntry> =>
	desired.tables.map((table): TableDiffEntry => {
		const actualTable = actual.get(table.name)
		if (!actualTable) {
			return { status: "missing", name: table.name, kind: table.kind }
		}
		// If the customer has an object of the same name but a different kind
		// (e.g. a regular table where we expect a materialized view), the
		// previous behavior was to fall through to the MV presence check and
		// return `up_to_date`, leaving the MV uncreated and downstream
		// aggregates unpopulated. Surface a `wrong_kind` drift instead so
		// apply can skip with a clear error.
		if (actualTable.kind !== table.kind) {
			return {
				status: "wrong_kind",
				name: table.name,
				kind: table.kind,
				actualKind: actualTable.kind,
			}
		}
		// Materialized views: presence-only check in v1 (kind already matched above).
		if (table.kind === "materialized_view") {
			return { status: "up_to_date", name: table.name, kind: table.kind }
		}
		const drifts = diffColumns(table, actualTable)
		if (drifts.length === 0) {
			return { status: "up_to_date", name: table.name, kind: table.kind }
		}
		return { status: "drifted", name: table.name, kind: table.kind, columnDrifts: drifts }
	})
