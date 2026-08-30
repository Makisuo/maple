// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Write-filter/read-guard sync for `ai_trace_index`.
//
// The rollups doc records the failure mode this exists for: a materialized
// view whose write filter and read fast-path agree with each other and
// disagree with reality sits at 0 rows forever, and every SQL-text test still
// passes (`span_metrics_calls_hourly` did exactly that). Agent Sessions
// detection reads `ai_trace_index` exclusively, so an MV that never fires
// renders the page permanently empty while looking healthy.
//
// So this suite proves rows, not text: it inserts vendor-stamped spans into
// `traces` on a database built by replaying the real migration chain, then
// asserts the MV materialized them — per column, because a `TO`-table view
// inserts by NAME and silently fills a mistyped alias's target column with
// `''` — and finally runs the real compiled list query end to end over the
// same data.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import {
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_TRACE_SESSION_PREFIX,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
} from "@maple/domain/gen-ai"
import * as Integrations from "@maple/query-engine-integrations"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ai_trace_index_e2e")
const ORG_ID = "org_ai_trace_index_e2e"

// Anchored to now, not a calendar date: `traces` and `ai_trace_index` both
// carry a 30-day TTL enforced at insert, and a hardcoded date would one day
// silently drop every seed and let the suite compare nothing to nothing.
const HOUR_MS = 3_600_000
const BASE_MS = Date.now() - 2 * HOUR_MS

const chDateTime = (epochMs: number): string =>
	new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

const quote = (value: string): string => `'${value.replaceAll("'", "\\'")}'`

const FOREIGN_ORG_ID = "org_ai_trace_index_e2e_other"

const SESSION_ID = `${ORG_ID}:inv-e2e-1`
const AGENT_TRACE = "aitraceindexe2e000000000000000001"
const SESSIONLESS_TRACE = "aitraceindexe2e000000000000000002"
const PLAIN_TRACE = "aitraceindexe2e000000000000000003"

interface SeedSpan {
	readonly traceId: string
	readonly spanId: string
	readonly ms: number
	readonly service: string
	readonly status: string
	readonly attrs: Readonly<Record<string, string>>
}

// Three populations, keyed off the constants the MV's write filter is rendered
// from: a session-bearing agent span, a sessionless agent span carrying the
// failure attributes, and a plain span that must NOT materialize.
const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	{
		traceId: AGENT_TRACE,
		spanId: "span-agent-1",
		ms: BASE_MS,
		service: "agent-service",
		status: "Ok",
		attrs: {
			[MAPLE_AI_VENDOR_ID_ATTR]: "eve",
			[MAPLE_AI_VENDOR_VERSION_ATTR]: "1.2.3",
			[MAPLE_AI_SESSION_ID_ATTR]: SESSION_ID,
		},
	},
	{
		traceId: SESSIONLESS_TRACE,
		spanId: "span-agent-2",
		ms: BASE_MS + 60_000,
		service: "agent-service",
		status: "Error",
		attrs: {
			[MAPLE_AI_VENDOR_ID_ATTR]: "vercel_ai_sdk",
			"error.type": "RateLimitError",
			"gen_ai.response.status": "failed",
		},
	},
	{
		traceId: PLAIN_TRACE,
		spanId: "span-plain-1",
		ms: BASE_MS + 120_000,
		service: "web-service",
		status: "Ok",
		attrs: { "http.request.method": "GET" },
	},
]

// A vendor span under ANOTHER org: it must materialize under its own OrgId —
// the one by-name mapping mistake with cross-tenant consequences — and the
// org-scoped list query below must never surface it.
const FOREIGN_SPAN: SeedSpan = {
	traceId: "aitraceindexe2e000000000000000004",
	spanId: "span-foreign-1",
	ms: BASE_MS + 180_000,
	service: "agent-service",
	status: "Ok",
	attrs: { [MAPLE_AI_VENDOR_ID_ATTR]: "eve" },
}

const chMap = (attrs: Readonly<Record<string, string>>): string =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

const seed = async (): Promise<void> => {
	const rows = [
		...SEED_SPANS.map((span) => [ORG_ID, span] as const),
		[FOREIGN_ORG_ID, FOREIGN_SPAN] as const,
	]
		.map(
			([orgId, span]) =>
				`(${quote(orgId)}, ${quote(chDateTime(span.ms))}, ${quote(span.traceId)}, ${quote(span.spanId)}, '', 'agent turn', 'Internal', ${quote(span.service)}, 1000000, ${quote(span.status)}, 1, ${chMap(span.attrs)})`,
		)
		.join("\n,")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, SpanAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

describe.skipIf(!clickhouseE2eEnabled)("ai_trace_index materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("materializes exactly the vendor-stamped spans, column by column", async () => {
		const rows = await runJson(
			`SELECT OrgId, toString(Timestamp) AS Timestamp, TraceId, SessionId, VendorId, VendorVersion, ServiceName, StatusCode, ErrorType, ResponseStatus
			 FROM ai_trace_index ORDER BY Timestamp ASC`,
		)

		assert.deepStrictEqual(rows, [
			{
				OrgId: ORG_ID,
				Timestamp: `${chDateTime(SEED_SPANS[0]!.ms)}.000000000`,
				TraceId: AGENT_TRACE,
				SessionId: SESSION_ID,
				VendorId: "eve",
				VendorVersion: "1.2.3",
				ServiceName: "agent-service",
				StatusCode: "Ok",
				ErrorType: "",
				ResponseStatus: "",
			},
			{
				OrgId: ORG_ID,
				Timestamp: `${chDateTime(SEED_SPANS[1]!.ms)}.000000000`,
				TraceId: SESSIONLESS_TRACE,
				SessionId: "",
				VendorId: "vercel_ai_sdk",
				VendorVersion: "",
				ServiceName: "agent-service",
				StatusCode: "Error",
				ErrorType: "RateLimitError",
				ResponseStatus: "failed",
			},
			{
				OrgId: FOREIGN_ORG_ID,
				Timestamp: `${chDateTime(FOREIGN_SPAN.ms)}.000000000`,
				TraceId: FOREIGN_SPAN.traceId,
				SessionId: "",
				VendorId: "eve",
				VendorVersion: "",
				ServiceName: "agent-service",
				StatusCode: "Ok",
				ErrorType: "",
				ResponseStatus: "",
			},
		])
	})

	it("feeds the real compiled list query end to end", async () => {
		const compiled = compileUnsafe(Integrations.aiSessionListQuery(), {
			orgId: ORG_ID,
			startTime: chDateTime(BASE_MS - HOUR_MS),
			endTime: chDateTime(BASE_MS + HOUR_MS),
		})
		// Decoded through the query's own row schema, exactly as `compiledQuery`
		// does in production — the raw JSON alone would not catch a wire shape
		// the schema refuses.
		const rows = Effect.runSync(compiled.decodeRows(await runJson(compiled.sql)))

		// Newest session first: the sessionless agent trace files under its own
		// `trace:` key, the session-bearing one under the vendor's id, and the
		// plain trace and the foreign org's trace must not appear at all.
		assert.deepStrictEqual(
			rows.map((row) => [row.sessionId, row.vendorId, row.traceCount]),
			[
				[`${MAPLE_AI_TRACE_SESSION_PREFIX}${SESSIONLESS_TRACE}`, "vercel_ai_sdk", 1],
				[SESSION_ID, "eve", 1],
			],
		)
	})
})
