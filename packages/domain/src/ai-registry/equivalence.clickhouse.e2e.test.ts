// Rust↔SQL differential: the compiled registry, evaluated over the rows ingest wrote.
//
// `./compile-sql.clickhouse.e2e.test.ts` proves the generated SQL parses and type-checks.
// This suite proves it *means the same thing* as the Rust classifier in `apps/ingest`.
//
// The input is `__fixtures__/equivalence-spans.jsonl`: adversarial synthetic spans driven
// through `encode_traces` — the real row writer — by
// `apps/ingest/src/ai_equivalence_fixtures.rs`, each record carrying the exact NDJSON row
// the writer produced. Those rows already carry the Rust verdict in `ai_vendor` /
// `ai_session_key_state`, so the differential needs no join key and no second source of
// truth: it is `WHERE computed != stored` over the real `traces` schema, after replaying
// the rows through the real INSERT statement.
//
//   bun ch:up
//   CLICKHOUSE_E2E=1 bun run --cwd packages/domain test -- equivalence.clickhouse.e2e
//
// Scope note: this proves Rust↔SQL. trace-capture's reference evaluator
// (`scripts/verify-seed.ts`) is a third implementation with a different kvlist/bytes
// canonicalization; it is out of this loop by construction, because SQL reads the string
// the row writer already produced. See the fixture README.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compileAiRegistrySql, compilePredicateSql, renderAiRegistrySelect } from "./compile-sql"
import {
	ANALYZER_STRICTNESS,
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseSelect,
	createDatabase,
	describeRow,
	dropDatabase,
	dropTracesRetentionTtl,
	insertTracesRows,
	loadSyntheticFixtures,
	rowSpanId,
	uniqueDatabase,
} from "./equivalence-support"

const database = uniqueDatabase("maple_ai_equivalence_e2e")
const orgId = "org_equivalence"
const compiled = compileAiRegistrySql()

const fixtures = loadSyntheticFixtures()
const bySpanId = new Map(fixtures.map((record) => [rowSpanId(record), record]))

/**
 * Spans whose Rust and SQL verdicts differ, pinned to the measured SQL verdict.
 *
 * **Empty, and expected to stay that way.** The two engines are exact mirrors: both
 * resolve a matcher's keys in the one attribute list its class names (`targetForClass`
 * here, `Matcher::target` in `apps/ingest/src/ai_registry.rs`), both treat the four
 * pseudo-keys as class-free columns, and both read span attributes for the class-less
 * predicates (unknown-tier fingerprints, session candidates, authority predicates).
 *
 * Until 2026-08 twelve spans were pinned here, under two findings that were really one
 * root cause: the Rust classifier resolved every key span → scope → resource regardless
 * of class. Its worst consequence was that `langsmith.internal_provider` — langchain's
 * *insufficient* resource matcher key, which also lies inside langchain's attr-class
 * `key_prefix(langsmith.)` family — satisfied that attr matcher from the resource, and
 * the attr matcher promotes, so one resource attribute classified **every span of the
 * process** as langchain, plain HTTP included and the value ignored. That defeated plan
 * §1's sufficiency gate. Rust is now class-directed; the fallback survives only in
 * trace-capture's single-seed `scripts/verify-seed.ts`, and no capture-corpus span
 * distinguishes the two rules.
 *
 * A new entry here needs a written rationale for why a *deliberate* divergence is
 * correct. The default reading of a mismatch is a bug on one side.
 */
interface PinnedDivergence {
	readonly vendor: string
	readonly sessionState: number
	readonly why: string
}

const PINNED_DIVERGENCES: Readonly<Record<string, PinnedDivergence>> = {}

interface DifferentialRow {
	readonly SpanId: string
	readonly AiVendor: string
	readonly AiVendorComputed: string
	readonly AiSessionKeyState: number
	readonly AiSessionKeyStateComputed: number
}

const DIFFERENTIAL_COLUMNS = ["SpanId", "AiVendor", "AiSessionKeyState"] as const

/** Every row with its stored (Rust) and computed (SQL) verdict side by side. */
const differentialSql = (): string =>
	`SELECT * FROM (\n${renderAiRegistrySelect(compiled, "traces", {
		passthrough: [...DIFFERENTIAL_COLUMNS],
	})}\n)`

const report = (rows: ReadonlyArray<DifferentialRow>): string =>
	rows
		.map((row) => {
			const record = bySpanId.get(row.SpanId)
			return [
				`- ${record?.id ?? row.SpanId} [${record?.category ?? "?"}] ${record?.note ?? ""}`,
				`  rust = ${JSON.stringify(row.AiVendor)}/${row.AiSessionKeyState}   sql = ${JSON.stringify(row.AiVendorComputed)}/${row.AiSessionKeyStateComputed}`,
				record === undefined ? "" : describeRow(record.row),
			]
				.filter((line) => line.length > 0)
				.join("\n")
		})
		.join("\n\n")

describe.skipIf(!clickhouseE2eEnabled)("Rust↔SQL span classification equivalence", () => {
	let differential: ReadonlyArray<DifferentialRow> = []

	beforeAll(async () => {
		await createDatabase(database)
		await applyRealMigrations(database)
		await dropTracesRetentionTtl(database)
		const inserted = await insertTracesRows(
			database,
			orgId,
			fixtures.map((record) => record.row),
		)
		expect(inserted).toBe(fixtures.length)
		differential = await clickhouseSelect<DifferentialRow>(
			differentialSql(),
			database,
			ANALYZER_STRICTNESS,
		)
	}, 180_000)

	afterAll(async () => {
		await dropDatabase(database)
	}, 30_000)

	it("round-trips every fixture row through the real INSERT unchanged", async () => {
		expect(fixtures.length).toBeGreaterThan(250)
		const stored = await clickhouseSelect<{
			readonly SpanId: string
			readonly AiVendor: string
			readonly AiSessionKeyState: number
			readonly Hash: string
			readonly AiRulesVersion: number
		}>(
			"SELECT SpanId, AiVendor, AiSessionKeyState, toString(AiSessionKeyHash) AS Hash, AiRulesVersion FROM traces",
			database,
		)
		expect(stored).toHaveLength(fixtures.length)
		for (const row of stored) {
			const record = bySpanId.get(row.SpanId)
			expect(record, `no fixture for span ${row.SpanId}`).toBeDefined()
			// The stored columns must still be exactly what Rust wrote — in particular the
			// UInt64 hash, which is the value the hash-alignment suite compares against.
			expect({ id: record?.id, ...row }).toEqual({
				id: record?.id,
				SpanId: row.SpanId,
				AiVendor: record?.rust?.vendor,
				AiSessionKeyState: record?.rust?.session_state,
				Hash: record?.rust?.session_key_hash,
				AiRulesVersion: record?.rust?.rules_version,
			})
		}
	})

	it("computes the same vendor and session-key state as the Rust writer for every span", () => {
		expect(differential).toHaveLength(fixtures.length)
		const mismatches = differential.filter(
			(row) =>
				row.AiVendorComputed !== row.AiVendor ||
				row.AiSessionKeyStateComputed !== row.AiSessionKeyState,
		)
		const unexpected = mismatches.filter((row) => {
			const record = bySpanId.get(row.SpanId)
			return record === undefined || PINNED_DIVERGENCES[record.id] === undefined
		})
		expect(unexpected.length, `Rust/SQL verdicts differ:\n\n${report(unexpected)}\n`).toBe(0)
	})

	it("diverges on exactly the spans PINNED_DIVERGENCES lists, and nothing else", () => {
		const mismatches = new Map(
			differential
				.filter(
					(row) =>
						row.AiVendorComputed !== row.AiVendor ||
						row.AiSessionKeyStateComputed !== row.AiSessionKeyState,
				)
				.map((row) => [bySpanId.get(row.SpanId)?.id ?? row.SpanId, row]),
		)
		for (const [id, pinned] of Object.entries(PINNED_DIVERGENCES)) {
			const row = mismatches.get(id)
			expect(
				row,
				`${id} no longer diverges — remove it from PINNED_DIVERGENCES (${pinned.why})`,
			).toBeDefined()
			expect({ vendor: row?.AiVendorComputed, sessionState: row?.AiSessionKeyStateComputed }).toEqual({
				vendor: pinned.vendor,
				sessionState: pinned.sessionState,
			})
		}
		// Nothing diverges that is not pinned — today, nothing diverges at all.
		expect(Object.keys(PINNED_DIVERGENCES).sort()).toEqual([...mismatches.keys()].sort())
	})

	it("keeps present-but-empty distinguishable from absent", () => {
		// The algebra's load-bearing subtlety, asserted as an absolute value rather than
		// merely "the same as Rust": `mapContains` must see a key whose value is '', where
		// `!= ''` would collapse state 4 into state 3 and drop the unknown-tier fingerprint.
		const verdict = (id: string): DifferentialRow => {
			const spanId = fixtures.find((record) => record.id === id)
			expect(spanId, `missing fixture ${id}`).toBeDefined()
			const row = differential.find((candidate) => candidate.SpanId === rowSpanId(spanId as never))
			expect(row, `no differential row for ${id}`).toBeDefined()
			return row as DifferentialRow
		}

		expect(verdict("present_empty/unknown_genai").AiVendorComputed).toBe("unknown:genai")
		expect(verdict("present_empty/unknown_openinference").AiVendorComputed).toBe("unknown:openinference")
		expect(verdict("present_empty/state4_vs_state3_empty").AiSessionKeyStateComputed).toBe(4)
		expect(verdict("present_empty/state4_vs_state3_absent").AiSessionKeyStateComputed).toBe(3)
		// An empty authority value still satisfies a `present()` authority predicate.
		expect(verdict("present_empty/authority_key_empty").AiSessionKeyStateComputed).toBe(6)
		// …and cannot satisfy an `eq()` one: flue's gated candidate scores 2, and its
		// ALWAYS candidate carries the reduction to 3 (key absent).
		expect(verdict("present_empty/eq_authority_empty").AiSessionKeyStateComputed).toBe(3)
		// `eq()` against a non-empty literal must not match an empty value.
		expect(verdict("present_empty/eq_matcher_not_satisfied").AiVendorComputed).toBe("")
	})

	it("evaluates value_prefix identically to a byte compare over the same column", async () => {
		// `value_prefix` (D1) is the one operator the registry does not currently use, so no
		// vendor branch exercises it and the differential above cannot reach it. It is still
		// part of the algebra both engines must implement, and Rust implements it as
		// `value.starts_with(prefix)` over the pseudo-key's *canonical string* — the same
		// string the row's column holds. So the claim is checkable without a registry rule:
		// compile the predicate, evaluate it in ClickHouse over every fixture row, and compare
		// against the byte compare Rust would do on the same column value.
		const probes = [
			{ key: "scope.name", prefix: "openinference." },
			{ key: "scope.name", prefix: "com.anthropic.claude_code" },
			{ key: "scope.name", prefix: "" },
			{ key: "span.name", prefix: "LanguageModel." },
			{ key: "span.name", prefix: "claude_code.interaction" },
			{ key: "scope.version", prefix: "1.2" },
			{ key: "scope.version", prefix: "2.0.0-rc" },
			{ key: "scope.schema_url", prefix: "https://opentelemetry.io/" },
			// Multi-byte: the prefix ends inside a sequence of astral characters.
			{ key: "span.name", prefix: "LanguageModel.generateTé" },
		] as const
		const rowColumn: Readonly<Record<string, string>> = {
			"scope.name": "scope_name",
			"span.name": "span_name",
			"scope.version": "scope_version",
			"scope.schema_url": "scope_schema_url",
		}

		const projections = probes
			.map(
				(probe, index) =>
					`toUInt8(${compilePredicateSql({ op: "value_prefix", key: probe.key, prefix: probe.prefix }, "span")}) AS p${index}`,
			)
			.join(",\n\t")
		const results = await clickhouseSelect<Readonly<Record<string, string | number>>>(
			`SELECT SpanId,\n\t${projections}\nFROM traces`,
			database,
			ANALYZER_STRICTNESS,
		)
		expect(results).toHaveLength(fixtures.length)

		const disagreements: string[] = []
		for (const result of results) {
			const record = bySpanId.get(String(result.SpanId))
			if (record === undefined) continue
			const row: unknown = JSON.parse(record.row)
			const fields = row as Readonly<Record<string, unknown>>
			probes.forEach((probe, index) => {
				const columnName = rowColumn[probe.key] as string
				const value = fields[columnName]
				const expected = typeof value === "string" && value.startsWith(probe.prefix) ? 1 : 0
				if (Number(result[`p${index}`]) !== expected)
					disagreements.push(
						`${record.id}: value_prefix(${probe.key}, ${JSON.stringify(probe.prefix)}) sql=${result[`p${index}`]} bytes=${expected} column=${JSON.stringify(value)}`,
					)
			})
		}
		expect(disagreements, disagreements.join("\n")).toEqual([])
	})

	it("reproduces the first-occurrence-wins dedup the row writer applied", () => {
		// The row Map keeps the first occurrence for registry keys only; SQL reads that Map,
		// so agreement here is what makes partial dedup sound (plan §6).
		const verdictFor = (id: string): DifferentialRow => {
			const record = fixtures.find((candidate) => candidate.id === id)
			const row = differential.find((candidate) => candidate.SpanId === rowSpanId(record as never))
			expect(row, `no differential row for ${id}`).toBeDefined()
			return row as DifferentialRow
		}
		expect(verdictFor("duplicate/gen_ai_system_spring_first").AiVendorComputed).toBe("spring_ai")
		expect(verdictFor("duplicate/gen_ai_system_strands_first").AiVendorComputed).toBe("strands")
		expect(verdictFor("duplicate/session_id_valid_then_empty").AiSessionKeyStateComputed).toBe(6)
		expect(verdictFor("duplicate/session_id_empty_then_valid").AiSessionKeyStateComputed).toBe(4)
	})
})
