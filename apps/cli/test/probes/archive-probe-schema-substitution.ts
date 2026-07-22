// Adversarial probe: schema substitution rejection. The reviewer's round-3
// attack: source Array(UInt64) vs injected Array(String) Parquet reopened
// schema. compareSchema must reject it. Also confirms a valid round-trip schema
// is accepted. Contract: exit 0 (PASS) when the substitution is rejected AND the
// valid schema is accepted; exit nonzero if either check is wrong.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-schema-substitution.ts

import { ArchiveProbe } from "../archive-probe-helpers"
import { compareSchema } from "../../src/server/archives/export"

const h = ArchiveProbe.create("schema-substitution")

const source = [
	{ name: "OrgId", type: "LowCardinality(String)" },
	{ name: "TraceId", type: "String" },
	{ name: "BucketCounts", type: "Array(UInt64)" },
	{ name: "Bounds", type: "Array(Float64)" },
	{ name: "Attributes", type: "Map(LowCardinality(String), String)" },
	{ name: "Timestamp", type: "DateTime64(9)" },
	{ name: "Min", type: "Nullable(Float64)" },
]

const parquetFrom = (overrides: Record<string, string>) =>
	source.map((c) => ({ name: c.name, type: overrides[c.name] ?? c.type }))

try {
	// 1. Valid round-trip must be accepted.
	const valid: Record<string, string> = {
		OrgId: "String",
		BucketCounts: "Array(UInt64)",
		Bounds: "Array(Float64)",
		Attributes: "Map(String, String)",
		Timestamp: "DateTime64(9, 'UTC')",
		Min: "Nullable(Float64)",
	}
	compareSchema(source, parquetFrom(valid), "<valid>") // must not throw

	// 2. Array(UInt64) -> Array(String) must be rejected.
	let rejected = false
	try {
		compareSchema(source, parquetFrom({ ...valid, BucketCounts: "Array(String)" }), "<attack>")
	} catch {
		rejected = true
	}
	if (!rejected) h.fail("source Array(UInt64) accepted against injected Array(String)")

	// 3. Map value-type substitution must be rejected.
	let mapRejected = false
	try {
		compareSchema(source, parquetFrom({ ...valid, Attributes: "Map(String, Int64)" }), "<attack2>")
	} catch {
		mapRejected = true
	}
	if (!mapRejected) h.fail("Map value-type substitution accepted")

	h.ok("Array(UInt64)!=Array(String) and Map value-type substitution both rejected; valid schema accepted")
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
