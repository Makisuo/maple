// Full-corpus Rust↔SQL differential — the on-demand gate.
//
// `./equivalence.clickhouse.e2e.test.ts` runs the *synthetic* fuzz surface, which is
// checked in and always available. This suite runs the same differential over every span
// of the trace-capture corpus (~10k spans across 57 captures), replayed through the real
// row writer. The corpus is a sibling repo, not a vendored fixture, so both halves are
// opt-in and neither runs in CI:
//
//   # 1. emit rows + verdicts from the real writer (apps/ingest)
//   TRACE_CAPTURE_DIR=~/Documents/repos/trace-capture \
//   CORPUS_EQUIVALENCE_OUT=/tmp/corpus-equivalence.jsonl \
//     cargo test -p maple-ingest --lib write_corpus_equivalence_fixture -- --ignored --nocapture
//
//   # 2. replay them into ClickHouse and compare (this file)
//   bun ch:up
//   CLICKHOUSE_E2E=1 CORPUS_EQUIVALENCE_FIXTURES=/tmp/corpus-equivalence.jsonl \
//     bun run --cwd packages/domain test -- corpus-equivalence.clickhouse.e2e
//
// The artifact is ~150 MB (the corpus contains multi-megabyte spans), which is why it is
// streamed rather than loaded, and why it is never checked in.

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compileAiRegistrySql, renderAiRegistrySelect } from "./compile-sql"
import {
	ANALYZER_STRICTNESS,
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	clickhouseSelect,
	createDatabase,
	dropDatabase,
	dropTracesRetentionTtl,
	insertTracesRows,
	uniqueDatabase,
} from "./equivalence-support"
import type { FixtureRecord } from "./equivalence-support"

const fixturePath = process.env.CORPUS_EQUIVALENCE_FIXTURES
const enabled = clickhouseE2eEnabled && fixturePath !== undefined && fixturePath.length > 0

const database = uniqueDatabase("maple_ai_corpus_equivalence")
const orgId = "org_equivalence"
const compiled = compileAiRegistrySql()

/**
 * The corpus spreads across years of `Timestamp` values, and `traces` partitions by day.
 * ClickHouse's default `max_partitions_per_insert_block` (100) would reject a batch that
 * straddles more days than that; the production writer never sees such a batch because it
 * writes what one exporter sent. Lifted here rather than reshaping the replay, which would
 * mean not replaying the corpus.
 */
const CORPUS_INSERT_SETTINGS: Readonly<Record<string, string>> = { max_partitions_per_insert_block: "0" }

interface MismatchRow {
	readonly SpanId: string
	readonly ServiceName: string
	readonly ScopeName: string
	readonly SpanName: string
	readonly AiVendor: string
	readonly AiVendorComputed: string
	readonly AiSessionKeyState: number
	readonly AiSessionKeyStateComputed: number
	readonly SpanAttributes: Readonly<Record<string, string>>
	readonly ResourceAttributes: Readonly<Record<string, string>>
	readonly ScopeAttributes: Readonly<Record<string, string>>
}

const PASSTHROUGH = [
	"SpanId",
	"ServiceName",
	"ScopeName",
	"SpanName",
	"AiVendor",
	"AiSessionKeyState",
	"SpanAttributes",
	"ResourceAttributes",
	"ScopeAttributes",
] as const

const differentialSql = (where: string): string =>
	`SELECT * FROM (\n${renderAiRegistrySelect(compiled, "traces", { passthrough: [...PASSTHROUGH] })}\n)\nWHERE ${where}`

let replayed = 0

describe.skipIf(!enabled)("full-corpus Rust↔SQL equivalence", () => {
	beforeAll(async () => {
		await createDatabase(database)
		await applyRealMigrations(database)
		await dropTracesRetentionTtl(database)

		const stream = createInterface({
			input: createReadStream(fixturePath as string, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		})
		let batch: string[] = []
		for await (const line of stream) {
			if (line.trim().length === 0) continue
			const record = JSON.parse(line) as FixtureRecord
			batch.push(record.row)
			if (batch.length >= 500) {
				replayed += await insertTracesRows(
					database,
					orgId,
					batch,
					8 * 1024 * 1024,
					CORPUS_INSERT_SETTINGS,
				)
				batch = []
			}
		}
		if (batch.length > 0)
			replayed += await insertTracesRows(
				database,
				orgId,
				batch,
				8 * 1024 * 1024,
				CORPUS_INSERT_SETTINGS,
			)
	}, 1_800_000)

	afterAll(async () => {
		await dropDatabase(database)
	}, 60_000)

	it("replays every captured row into the real traces schema", async () => {
		expect(replayed).toBeGreaterThan(9_000)
		const stored = await clickhouseSelect<{ readonly count: string }>(
			"SELECT toString(count()) AS count FROM traces",
			database,
		)
		expect(Number(stored[0]?.count)).toBe(replayed)
	}, 120_000)

	it("computes the same vendor and session-key state as the Rust writer for every corpus span", async () => {
		const where = "AiVendorComputed != AiVendor OR AiSessionKeyStateComputed != AiSessionKeyState"
		const counted = await clickhouseSelect<{ readonly mismatches: string; readonly total: string }>(
			`SELECT
	toString(countIf(${where})) AS mismatches,
	toString(count()) AS total
FROM (\n${renderAiRegistrySelect(compiled, "traces", { passthrough: [...PASSTHROUGH] })}\n)`,
			database,
			ANALYZER_STRICTNESS,
		)
		const mismatches = Number(counted[0]?.mismatches ?? -1)
		if (mismatches === 0) {
			expect(Number(counted[0]?.total)).toBe(replayed)
			return
		}

		// A mismatch is a finding. Print enough of the offending spans to act on without
		// re-running anything: both verdicts and all three attribute maps.
		const samples = await clickhouseSelect<MismatchRow>(
			`${differentialSql(where)}\nLIMIT 20`,
			database,
			ANALYZER_STRICTNESS,
		)
		const breakdown = await clickhouseSelect<{
			readonly AiVendor: string
			readonly AiVendorComputed: string
			readonly spans: string
		}>(
			`SELECT AiVendor, AiVendorComputed, toString(count()) AS spans
FROM (\n${renderAiRegistrySelect(compiled, "traces", { passthrough: [...PASSTHROUGH] })}\n)
WHERE ${where}
GROUP BY AiVendor, AiVendorComputed
ORDER BY count() DESC`,
			database,
			ANALYZER_STRICTNESS,
		)
		const report = [
			`${mismatches} of ${counted[0]?.total} corpus spans disagree.`,
			"",
			"by (rust vendor → sql vendor):",
			...breakdown.map(
				(row) =>
					`  ${JSON.stringify(row.AiVendor)} → ${JSON.stringify(row.AiVendorComputed)}: ${row.spans}`,
			),
			"",
			...samples.map((row) =>
				[
					`- ${row.ServiceName} / ${row.ScopeName} / ${row.SpanName} (${row.SpanId})`,
					`  rust = ${JSON.stringify(row.AiVendor)}/${row.AiSessionKeyState}   sql = ${JSON.stringify(row.AiVendorComputed)}/${row.AiSessionKeyStateComputed}`,
					`  span     = ${JSON.stringify(row.SpanAttributes).slice(0, 800)}`,
					`  scope    = ${JSON.stringify(row.ScopeAttributes).slice(0, 400)}`,
					`  resource = ${JSON.stringify(row.ResourceAttributes).slice(0, 400)}`,
				].join("\n"),
			),
		].join("\n")
		expect(mismatches, report).toBe(0)
	}, 600_000)

	it("classifies a non-trivial share of the corpus (the differential is not vacuous)", async () => {
		// Zero mismatches over ten thousand rows that all classified as non-AI would prove
		// nothing; this pins that the corpus really exercises the vendor branches.
		const rows = await clickhouseSelect<{ readonly vendors: string; readonly classified: string }>(
			`SELECT
	toString(uniqExact(AiVendor)) AS vendors,
	toString(countIf(AiVendor != '')) AS classified
FROM traces`,
			database,
		)
		expect(Number(rows[0]?.vendors)).toBeGreaterThan(20)
		expect(Number(rows[0]?.classified)).toBeGreaterThan(5_000)
	}, 120_000)

	it("keeps the stored rules version on every replayed row", async () => {
		const body = await clickhouseExec(
			"SELECT toString(uniqExact(AiRulesVersion)), toString(min(AiRulesVersion)) FROM traces FORMAT TabSeparated",
			database,
		)
		const [distinct, minimum] = body.trim().split("\t")
		expect(distinct).toBe("1")
		expect(Number(minimum)).toBe(compiled.rulesVersion)
	}, 60_000)
})
