// The analyzer gate for the compiled registry.
//
// `./compile-sql.test.ts` asserts on SQL text, and text is not a contract ClickHouse honours — the
// repo has already shipped an expression that produced exactly the intended string and was then
// rejected with `NO_COMMON_TYPE`. This suite runs the generated expressions through a real server.
//
// Scope, deliberately: it proves the SQL **parses, type-checks and executes** and that each
// expression resolves to the column type the `traces` schema expects. It does NOT assert per-span
// classification semantics — Rust/SQL differential equivalence is a later stage that needs the
// capture corpus, which is not vendored (see README.md).
//
// Gated on `CLICKHOUSE_E2E=1` exactly like the apps/api suites, so a plain `bun run test` never
// reaches for a server that isn't running:
//
//   bun ch:up
//   CLICKHOUSE_E2E=1 bun run --cwd packages/domain test -- compile-sql.clickhouse.e2e

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compileAiRegistrySql, renderAiRegistrySelect } from "./compile-sql"

const clickhouseE2eEnabled = process.env.CLICKHOUSE_E2E === "1"
const clickhouseUrl = process.env.CLICKHOUSE_E2E_URL ?? "http://127.0.0.1:8123"
const clickhouseUser = process.env.CLICKHOUSE_E2E_USER ?? "maple"
const clickhousePassword = process.env.CLICKHOUSE_E2E_PASSWORD ?? "maple"

/**
 * Managed Tinybird is ClickHouse 24.12 with `use_variant_as_common_type = 0`, where a type mismatch
 * between `multiIf` branches is a hard error. Modern local/CI servers default the setting ON and
 * quietly resolve the same expression to a `Variant`, which would let this suite pass on SQL that
 * fails in production. Pinned for the same reason the apps/api harness pins it.
 */
const ANALYZER_STRICTNESS: Record<string, string> = { use_variant_as_common_type: "0" }

const exec = async (
	sql: string,
	database = "default",
	settings: Record<string, string> = {},
): Promise<string> => {
	const query = new URLSearchParams({ database, ...settings })
	const response = await fetch(`${clickhouseUrl.replace(/\/$/, "")}/?${query.toString()}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			"Content-Type": "text/plain",
			"X-ClickHouse-User": clickhouseUser,
			"X-ClickHouse-Key": clickhousePassword,
			"X-ClickHouse-Database": database,
		},
		body: sql,
	})
	const body = await response.text()
	if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${body.slice(0, 1200)}`)
	return body
}

/** `DESCRIBE (SELECT …)` type-checks the whole query without reading a row. */
const describeQuery = async (sql: string): Promise<ReadonlyArray<{ name: string; type: string }>> => {
	const body = await exec(`DESCRIBE (\n${sql}\n) FORMAT TabSeparated`, database, ANALYZER_STRICTNESS)
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const [name, type] = line.split("\t")
			return { name: name ?? "", type: type ?? "" }
		})
}

const database = `maple_ai_registry_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const table = "traces_min"

/**
 * The seven `traces` columns the compiler reads, at their production types. A minimal table rather
 * than the full migration set: the compiler only ever touches these, and the column *types* — in
 * particular `Map(LowCardinality(String), String)`, which is what makes `startsWith` over
 * `mapKeys(...)` a real question — are what the analyzer needs to see.
 */
const createTable = `
CREATE TABLE ${table} (
	SpanName LowCardinality(String),
	ScopeName String,
	ScopeVersion String,
	ScopeSchemaUrl String,
	ResourceAttributes Map(LowCardinality(String), String),
	ScopeAttributes Map(LowCardinality(String), String),
	SpanAttributes Map(LowCardinality(String), String)
) ENGINE = MergeTree ORDER BY tuple()`

/** One span per shape the algebra can hit, so the SELECT executes over non-trivial input. */
const rows = [
	// Sufficient scope match.
	{
		SpanName: "Agent.run",
		ScopeName: "openinference.instrumentation.agno",
		ScopeVersion: "1.0.1",
		ScopeSchemaUrl: "",
		ResourceAttributes: {},
		ScopeAttributes: {},
		SpanAttributes: { "openinference.span.kind": "AGENT", "session.id": "s-1" },
	},
	// Promotion case: insufficient scope + a same-vendor attr hit.
	{
		SpanName: "chat_client",
		ScopeName: "org.springframework.boot",
		ScopeVersion: "4.1.0",
		ScopeSchemaUrl: "",
		ResourceAttributes: {},
		ScopeAttributes: {},
		SpanAttributes: { "spring.ai.kind": "chat_client", "spring.ai.chat.client.conversation.id": "c-1" },
	},
	// Negative promotion case: the same insufficient scope with no AI attribute at all.
	{
		SpanName: "POST",
		ScopeName: "org.springframework.boot",
		ScopeVersion: "4.1.0",
		ScopeSchemaUrl: "",
		ResourceAttributes: {},
		ScopeAttributes: {},
		SpanAttributes: { "http.request.method": "POST" },
	},
	// Present-but-empty: the case `!= ''` would collapse into "absent".
	{
		SpanName: "llm",
		ScopeName: "custom",
		ScopeVersion: "",
		ScopeSchemaUrl: "",
		ResourceAttributes: {},
		ScopeAttributes: {},
		SpanAttributes: { "gen_ai.operation.name": "" },
	},
	// Non-AI.
	{
		SpanName: "GET /health",
		ScopeName: "@opentelemetry/instrumentation-http",
		ScopeVersion: "0.57.0",
		ScopeSchemaUrl: "",
		ResourceAttributes: { "service.name": "web" },
		ScopeAttributes: {},
		SpanAttributes: { "http.request.method": "GET" },
	},
]

const compiled = compileAiRegistrySql()

describe.skipIf(!clickhouseE2eEnabled)("compiled AI registry SQL against ClickHouse", () => {
	beforeAll(async () => {
		await exec(`CREATE DATABASE ${database}`)
		await exec(createTable, database)
		await exec(
			`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join("\n")}`,
			database,
		)
	}, 60_000)

	afterAll(async () => {
		await exec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("type-checks the vendor expression to a String", async () => {
		const columns = await describeQuery(
			`SELECT ${compiled.vendorExpr} AS ${compiled.vendorAlias} FROM ${table}`,
		)
		expect(columns).toHaveLength(1)
		expect(columns[0]?.type).toBe("String")
	})

	it("type-checks the session-state expression to a UInt8", async () => {
		const columns = await describeQuery(
			`SELECT\n${compiled.vendorExpr} AS ${compiled.vendorAlias},\n${compiled.sessionStateExpr} AS ${compiled.sessionStateAlias}\nFROM ${table}`,
		)
		expect(columns.map((column) => column.name)).toEqual([
			compiled.vendorAlias,
			compiled.sessionStateAlias,
		])
		// The ladder is 0..6 and the storage column is UInt8; a wider type here means a branch
		// resolved to something other than a small literal.
		expect(columns[1]?.type).toBe("UInt8")
	})

	it("type-checks the layered select under analyzer strictness", async () => {
		const columns = await describeQuery(renderAiRegistrySelect(compiled, table))
		expect(columns.map((column) => `${column.name}:${column.type}`)).toEqual([
			`${compiled.vendorAlias}:String`,
			`${compiled.sessionStateAlias}:UInt8`,
			"AiSessionKeyValueComputed:String",
			"AiRulesVersionComputed:UInt32",
		])
	})

	it("stays inside the query-tree node limit that a flat select list blows", async () => {
		// Regression guard for the alias-inlining blow-up: this is the query shape the rebuild job
		// will run, and it must survive the analyzer with the real 21-vendor registry.
		const sql = renderAiRegistrySelect(compiled, table, { passthrough: ["SpanName"] })
		const columns = await describeQuery(sql)
		expect(columns[0]?.name).toBe("SpanName")
		expect(columns).toHaveLength(5)
	})

	it("executes over rows and returns one result per span", async () => {
		const body = await exec(
			`${renderAiRegistrySelect(compiled, table, { passthrough: ["SpanName"] })}\nORDER BY SpanName\nFORMAT JSONEachRow`,
			database,
			ANALYZER_STRICTNESS,
		)
		const results = body
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)

		expect(results).toHaveLength(rows.length)
		// Semantics are the differential suite's job; all this asserts is that every expression
		// produced a value of the right shape for every row.
		for (const result of results) {
			expect(typeof result[compiled.vendorAlias]).toBe("string")
			expect(typeof result[compiled.sessionStateAlias]).toBe("number")
			expect(typeof result.AiSessionKeyValueComputed).toBe("string")
			expect(result.AiRulesVersionComputed).toBe(compiled.rulesVersion)
		}
	})

	it("keeps present-but-empty distinguishable from absent", async () => {
		// The one semantic claim worth making here, because it is a property of the *generated SQL*
		// rather than of any vendor rule: `mapContains` must see the empty-valued key.
		const body = await exec(
			`SELECT ${compiled.vendorExpr} AS v FROM ${table} WHERE SpanName = 'llm' FORMAT TabSeparated`,
			database,
			ANALYZER_STRICTNESS,
		)
		expect(body.trim()).toBe("unknown:genai")
	})

	it("compiles against overridden aliases", async () => {
		const shadow = compileAiRegistrySql(undefined, { vendorAlias: "V", sessionStateAlias: "S" })
		const columns = await describeQuery(renderAiRegistrySelect(shadow, table))
		expect(columns.map((column) => column.name)).toEqual([
			"V",
			"S",
			"AiSessionKeyValueComputed",
			"AiRulesVersionComputed",
		])
	})
})
