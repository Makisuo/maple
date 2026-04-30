import { describe, expect, it } from "vitest"
import {
	computeSchemaDiff,
	type ActualTable,
	type DesiredSchema,
	type DesiredTable,
} from "./diff"

const desiredTable = (
	name: string,
	columns: ReadonlyArray<readonly [string, string]>,
): DesiredTable => ({
	name,
	kind: "table",
	columns: columns.map(([colName, type]) => ({ name: colName, type })),
	createStatement: `CREATE TABLE ${name} (...)`,
})

const desiredMv = (name: string): DesiredTable => ({
	name,
	kind: "materialized_view",
	columns: [],
	createStatement: `CREATE MATERIALIZED VIEW ${name} TO foo AS SELECT 1`,
})

const actualTable = (
	name: string,
	columns: ReadonlyArray<readonly [string, string]>,
): ActualTable => ({
	name,
	kind: "table",
	columns: columns.map(([colName, type]) => ({ name: colName, type })),
})

const actualMap = (...tables: ReadonlyArray<ActualTable>): Map<string, ActualTable> =>
	new Map(tables.map((t) => [t.name, t]))

describe("computeSchemaDiff", () => {
	it("flags every table as missing when actual schema is empty", () => {
		const desired: DesiredSchema = {
			tables: [
				desiredTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["Body", "String"],
				]),
				desiredMv("logs_aggregated"),
			],
		}
		const result = computeSchemaDiff(desired, actualMap())
		expect(result).toEqual([
			{ status: "missing", name: "logs", kind: "table" },
			{ status: "missing", name: "logs_aggregated", kind: "materialized_view" },
		])
	})

	it("returns up_to_date when every desired column matches by type", () => {
		const desired: DesiredSchema = {
			tables: [
				desiredTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["Body", "String"],
				]),
			],
		}
		const result = computeSchemaDiff(
			desired,
			actualMap(
				actualTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["Body", "String"],
				]),
			),
		)
		expect(result).toEqual([{ status: "up_to_date", name: "logs", kind: "table" }])
	})

	it("flags missing columns as drift", () => {
		const desired: DesiredSchema = {
			tables: [
				desiredTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["Body", "String"],
					["TraceId", "String"],
				]),
			],
		}
		const result = computeSchemaDiff(
			desired,
			actualMap(actualTable("logs", [["OrgId", "LowCardinality(String)"]])),
		)
		expect(result).toEqual([
			{
				status: "drifted",
				name: "logs",
				kind: "table",
				columnDrifts: [
					{ kind: "missing", column: "Body", expectedType: "String" },
					{ kind: "missing", column: "TraceId", expectedType: "String" },
				],
			},
		])
	})

	it("flags extra columns separately from up_to_date when they exist on cluster but not in desired", () => {
		const desired: DesiredSchema = {
			tables: [desiredTable("logs", [["OrgId", "LowCardinality(String)"]])],
		}
		const result = computeSchemaDiff(
			desired,
			actualMap(
				actualTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["legacy_field", "String"],
				]),
			),
		)
		expect(result).toEqual([
			{
				status: "drifted",
				name: "logs",
				kind: "table",
				columnDrifts: [
					{ kind: "extra", column: "legacy_field", actualType: "String" },
				],
			},
		])
	})

	it("flags type mismatches", () => {
		const desired: DesiredSchema = {
			tables: [desiredTable("logs", [["Timestamp", "DateTime64(3)"]])],
		}
		const result = computeSchemaDiff(
			desired,
			actualMap(actualTable("logs", [["Timestamp", "DateTime"]])),
		)
		expect(result).toEqual([
			{
				status: "drifted",
				name: "logs",
				kind: "table",
				columnDrifts: [
					{
						kind: "type_mismatch",
						column: "Timestamp",
						expectedType: "DateTime64(3)",
						actualType: "DateTime",
					},
				],
			},
		])
	})

	it("normalizes whitespace in nested types when comparing", () => {
		const desired: DesiredSchema = {
			tables: [
				desiredTable("logs", [
					["Attributes", "Map(LowCardinality(String), String)"],
				]),
			],
		}
		// CH sometimes reports the type without the space after the comma.
		const result = computeSchemaDiff(
			desired,
			actualMap(
				actualTable("logs", [
					["Attributes", "Map(LowCardinality(String),String)"],
				]),
			),
		)
		expect(result).toEqual([{ status: "up_to_date", name: "logs", kind: "table" }])
	})

	it("treats a materialized view as up_to_date as long as it exists on the cluster", () => {
		const desired: DesiredSchema = {
			tables: [desiredMv("logs_hourly")],
		}
		const result = computeSchemaDiff(
			desired,
			actualMap({
				name: "logs_hourly",
				kind: "materialized_view",
				columns: [{ name: "ignored", type: "String" }],
			}),
		)
		expect(result).toEqual([
			{ status: "up_to_date", name: "logs_hourly", kind: "materialized_view" },
		])
	})

	it("handles a mixed result across multiple tables", () => {
		const desired: DesiredSchema = {
			tables: [
				desiredTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["Body", "String"],
				]),
				desiredTable("metrics", [["OrgId", "LowCardinality(String)"]]),
				desiredMv("logs_hourly"),
			],
		}
		const result = computeSchemaDiff(
			desired,
			actualMap(
				actualTable("logs", [
					["OrgId", "LowCardinality(String)"],
					["Body", "String"],
				]),
				actualTable("metrics", [
					["OrgId", "LowCardinality(String)"],
					["legacy", "String"],
				]),
			),
		)
		expect(result).toEqual([
			{ status: "up_to_date", name: "logs", kind: "table" },
			{
				status: "drifted",
				name: "metrics",
				kind: "table",
				columnDrifts: [{ kind: "extra", column: "legacy", actualType: "String" }],
			},
			{ status: "missing", name: "logs_hourly", kind: "materialized_view" },
		])
	})
})
