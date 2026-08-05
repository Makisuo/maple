import { describe, expect, it } from "@effect/vitest"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import { journeyFacetsQuery, journeyListQuery, journeySummaryQuery, journeyTimelineQuery } from "./genai"

const WINDOW = { startTime: "2026-08-01 00:00:00", endTime: "2026-08-05 00:00:00" }
const listParams = { orgId: "org_1", ...WINDOW }
const journeyParams = { ...listParams, journeyId: "conv_42" }

describe("journey identity", () => {
	// The one real modeling decision in this feature. A per-span coalesce splits
	// one conversation into fragments whenever only some spans carry the id, so
	// the key is resolved per TRACE — and the fallback order decides whether the
	// view works for anyone but the emitter it was built against.
	it("coalesces conversation id → session id → trace id, per trace", () => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		expect(sql).toContain("OVER (PARTITION BY TraceId)")
		expect(sql).toContain("multiIf(max(if(SpanAttributes['gen_ai.conversation.id']")
		// TraceId is the last resort, so a single-turn trace is still a journey.
		expect(sql).toMatch(/TraceId\) AS journeyId/)
	})

	it("checks both attribute maps for session.id (browser SDKs set it on the resource)", () => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		expect(sql).toContain("SpanAttributes['session.id']")
		expect(sql).toContain("ResourceAttributes['session.id']")
	})

	// Containment says all three keys are read; only ORDER says which one wins.
	// A ladder that consults session.id before conversation.id silently splits a
	// multi-session conversation, or merges two conversations that share a tab.
	it("ranks the identity ladder conversation.id → session.id → TraceId", () => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		const start = sql.indexOf("multiIf(")
		const journeyIdExpr = sql.slice(start, sql.indexOf(" AS journeyId", start))
		const conversation = journeyIdExpr.indexOf("gen_ai.conversation.id")
		const session = journeyIdExpr.indexOf("session.id")
		const traceId = journeyIdExpr.lastIndexOf("TraceId)")
		expect(conversation).toBeGreaterThan(-1)
		// The middle rung is the one a containment assertion can't pin: it has to
		// sit after conversation.id and before the TraceId fallback.
		expect(session).toBeGreaterThan(conversation)
		expect(traceId).toBeGreaterThan(session)
	})
})

describe("attribute churn", () => {
	// `gen_ai.*` is still Development and has renamed once already. Both
	// generations coalesce in the query so a rename is one edit, not a sweep.
	it.each([
		["provider", "SpanAttributes['gen_ai.provider.name']", "SpanAttributes['gen_ai.system']"],
		[
			"input tokens",
			"SpanAttributes['gen_ai.usage.input_tokens']",
			"SpanAttributes['gen_ai.usage.prompt_tokens']",
		],
		[
			"output tokens",
			"SpanAttributes['gen_ai.usage.output_tokens']",
			"SpanAttributes['gen_ai.usage.completion_tokens']",
		],
		["input messages", "SpanAttributes['gen_ai.input.messages']", "SpanAttributes['gen_ai.prompt']"],
		[
			"output messages",
			"SpanAttributes['gen_ai.output.messages']",
			"SpanAttributes['gen_ai.completion']",
		],
		["tool name", "SpanAttributes['gen_ai.request.tool.name']", "SpanAttributes['gen_ai.tool.name']"],
	])("reads the new and legacy spelling of %s", (_label, current, legacy) => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		expect(sql).toContain(current)
		expect(sql).toContain(legacy)
	})

	// Reading both spellings is half the contract; the other half is which one
	// wins when an emitter sends BOTH during a migration. Inverted precedence
	// pins the deprecated value and looks correct in every containment check.
	it.each([
		["provider", "gen_ai.provider.name", "gen_ai.system", " AS provider"],
		["input messages", "gen_ai.input.messages", "gen_ai.prompt", " AS inputMessages"],
		["output messages", "gen_ai.output.messages", "gen_ai.completion", " AS outputMessages"],
		["input tokens", "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", " AS spanInputTokens"],
	])("prefers the current %s key over the legacy one", (_label, current, legacy, alias) => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		// The projection line, not the outer SELECT's bare alias reference.
		const line = sql.split("\n").find((l) => l.trimEnd().endsWith(`${alias},`) && l.includes("if("))!
		expect(line, `no projection line for ${alias}`).toBeDefined()
		// `if(current != '', current, legacy)` — the current key is the condition,
		// so it appears before the legacy fallback.
		expect(line.indexOf(current)).toBeLessThan(line.indexOf(legacy))
	})
})

describe("journeyTimelineQuery", () => {
	it("scopes to the org, the window, and GenAI spans only", () => {
		const compiled = compileCH(journeyTimelineQuery(), journeyParams)
		expect(compiled.sql).toContain("OrgId = 'org_1'")
		expect(compiled.sql).toContain("Timestamp >= '2026-08-01 00:00:00'")
		expect(compiled.sql).toContain("SpanAttributes['gen_ai.operation.name'] != ''")
		expect(compiled.tenantScope).toBe("org")
	})

	it("pins one journey and returns spans in chronological order", () => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		expect(sql).toContain("WHERE journeyId = 'conv_42'")
		expect(sql).toContain("ORDER BY timestamp ASC, spanId ASC")
	})

	// Duration is UInt64 nanoseconds; rendering it as-is puts 4-second turns at
	// four billion.
	it("converts Duration from nanoseconds to milliseconds", () => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		expect(sql).toContain("toFloat64(Duration) / 1000000 AS durationMs")
	})

	it("carries the span-event content count so events-only spans don't look broken", () => {
		const { sql } = compileCH(journeyTimelineQuery(), journeyParams)
		expect(sql).toContain("arrayFilter(x -> x LIKE 'gen_ai.%', EventsName)")
	})
})

describe("journeyListQuery", () => {
	it("groups by the derived journey id", () => {
		const { sql } = compileCH(journeyListQuery(), listParams)
		expect(sql).toContain("GROUP BY journeyId")
		expect(sql).toContain("FORMAT JSON")
	})

	// Wall-clock duration spans several spans, so it is max(end) - min(start).
	// Writing it as `max(a) - min(b) / 1e6` would parse as `max(a) - (min(b)/1e6)`
	// by SQL precedence and report an epoch-sized number.
	it("computes wall-clock duration with each side converted before subtracting", () => {
		const { sql } = compileCH(journeyListQuery(), listParams)
		expect(sql).toContain("max(endNs) / 1000000 - min(startNs) / 1000000 AS durationMs")
	})

	it("counts only inference operations as turns, and tool spans separately", () => {
		const { sql } = compileCH(journeyListQuery(), listParams)
		expect(sql).toContain("countIf(operation IN ('chat',")
		expect(sql).toContain("countIf(operation = 'execute_tool') AS toolCallCount")
	})

	// Cost has no stable convention: the row reports whether ANY span carried a
	// cost attribute so the UI can say "unknown" instead of "$0.00".
	it("tracks cost presence separately from the summed value", () => {
		const { sql } = compileCH(journeyListQuery(), listParams)
		expect(sql).toContain("countIf(costRaw != '') AS costSpanCount")
	})

	it("filters journeys post-aggregation so totals stay complete", () => {
		const { sql } = compileCH(journeyListQuery({ model: "gpt-4o", hasTools: true }), listParams)
		// A pre-aggregation model filter would drop the journey's other-model
		// spans and under-report its tokens.
		expect(sql).toContain("HAVING has(models, 'gpt-4o')")
		expect(sql).toContain("toolCallCount > 0")
		expect(sql).not.toContain("WHERE has(models")
	})

	it("treats error as outranking running, so the three statuses partition the list", () => {
		expect(compileCH(journeyListQuery({ status: "error" }), listParams).sql).toContain("errorCount > 0")
		const running = compileCH(journeyListQuery({ status: "running" }), listParams).sql
		expect(running).toContain("errorCount = 0")
		expect(running).toContain("isRunning = 1")
		// `ok` is the third bucket, and the only one that has to exclude BOTH of
		// the others — a journey that errored is not ok, and neither is one still
		// running. Without this the three buckets overlap and the counts double.
		const ok = compileCH(journeyListQuery({ status: "ok" }), listParams).sql
		expect(ok).toContain("(errorCount = 0 AND isRunning = 0)")
	})

	// An unknown cost cannot be said to fall within a bound — same reasoning as
	// the replays duration filter and its NULL in-progress sessions.
	it("excludes cost-less journeys from a cost bound", () => {
		const { sql } = compileCH(journeyListQuery({ costMin: 0.01 }), listParams)
		expect(sql).toContain("cost >= 0.01")
		expect(sql).toContain("costSpanCount > 0")
	})

	it("sorts by the requested dimension", () => {
		expect(compileCH(journeyListQuery({ sort: "cost" }), listParams).sql).toContain("ORDER BY cost DESC")
		expect(
			compileCH(journeyListQuery({ sort: "turns", sortDirection: "asc" }), listParams).sql,
		).toContain("ORDER BY turnCount ASC")
	})

	it("defaults to newest first with a page cap", () => {
		const { sql } = compileCH(journeyListQuery(), listParams)
		expect(sql).toContain("ORDER BY startTime DESC")
		expect(sql).toContain("LIMIT 50")
	})
})

describe("journeySummaryQuery", () => {
	// The header and the list row must never disagree about the same journey,
	// which is why they are the same aggregate with one extra predicate.
	it("is the list aggregate pinned to one journey", () => {
		const summary = compileCH(journeySummaryQuery(), journeyParams).sql
		const list = compileCH(journeyListQuery(), listParams).sql
		expect(summary).toContain("HAVING journeyId = 'conv_42'")
		expect(summary).toContain("LIMIT 1")
		const aggregateLine = "countIf(operation = 'execute_tool') AS toolCallCount"
		expect(summary).toContain(aggregateLine)
		expect(list).toContain(aggregateLine)
	})

	it("scopes to the org", () => {
		const compiled = compileCH(journeySummaryQuery(), journeyParams)
		expect(compiled.tenantScope).toBe("org")
		expect(compiled.sql).toContain("OrgId = 'org_1'")
	})
})

describe("journeyFacetsQuery", () => {
	it("emits every sidebar dimension with the shared {name, count, facetType} shape", () => {
		const { sql } = compileUnion(journeyFacetsQuery(), listParams)
		for (const facetType of [
			"'model' AS facetType",
			"'provider' AS facetType",
			"'agent' AS facetType",
			"'workflow' AS facetType",
			"'service' AS facetType",
			"'finishReason' AS facetType",
			"'status' AS facetType",
			"'tools' AS facetType",
			"'redacted' AS facetType",
			"'durationBucket' AS facetType",
		]) {
			expect(sql).toContain(facetType)
		}
	})

	// A journey that used three models contributes one count to each of them.
	it("explodes multi-valued dimensions and counts distinct journeys", () => {
		const { sql } = compileUnion(journeyFacetsQuery(), listParams)
		expect(sql).toContain("arrayJoin(models) AS name")
		expect(sql).toContain("uniq(journeyId) AS count")
	})

	// ---------------------------------------------------------------------
	// The facet/filter invariant, per branch.
	//
	// Every dimension must drop its OWN filter (a selected value still shows
	// its alternatives) and keep everyone else's (the counts describe the list
	// you are actually looking at). Checking one dimension is what let two
	// branches ship inverted: with `contentRedacted: false` selected, the
	// `redacted` branch inherited `contentSpanCount > 0` while its own WHERE
	// says `contentSpanCount = 0` — a contradiction, so the toggle read 0
	// forever and could never be un-selected. The duration histogram had the
	// same shape against its own range filter.
	//
	// Parameterized over every branch so a new dimension cannot be added
	// without declaring which predicate it owns.
	// ---------------------------------------------------------------------
	const ALL_FILTERS = {
		model: "gpt-4o",
		provider: "openai",
		agent: "planner",
		workflow: "triage",
		serviceName: "agent-service",
		finishReason: "length",
		status: "ok",
		hasTools: true,
		contentRedacted: false,
		durationMinMs: 1_000,
	} as const

	/** Each branch, the marker that identifies it, and the predicate it owns. */
	const FACET_BRANCHES: ReadonlyArray<[string, string, string]> = [
		["model", "'model' AS facetType", "has(models, 'gpt-4o')"],
		["provider", "'provider' AS facetType", "has(providers, 'openai')"],
		["agent", "'agent' AS facetType", "has(agents, 'planner')"],
		["finishReason", "'finishReason' AS facetType", "has(finishReasons, 'length')"],
		["workflow", "'workflow' AS facetType", "workflowName = 'triage'"],
		["service", "'service' AS facetType", "serviceName = 'agent-service'"],
		// The three status branches share one exclusion, so any one of them proves it.
		["status", "'status' AS facetType", "isRunning = 0"],
		["tools", "'tools' AS facetType", "toolCallCount > 0"],
		["redacted", "'redacted' AS facetType", "contentSpanCount > 0"],
		["durationBucket", "'durationBucket' AS facetType", "durationMs >= 1000"],
		["numericStats", "quantile(0.95)", "durationMs >= 1000"],
	]

	/**
	 * The inherited filter set only — a branch's own WHERE legitimately repeats
	 * the predicate it is counting (`tools` counts `toolCallCount > 0`), so
	 * matching the whole branch text cannot tell inheritance from definition.
	 */
	const havingOf = (branch: string): string => {
		const start = branch.indexOf("HAVING")
		if (start === -1) return ""
		const end = branch.indexOf(") AS ", start)
		return branch.slice(start, end === -1 ? undefined : end)
	}

	it.each(FACET_BRANCHES)("the %s branch drops its own predicate", (_name, marker, ownPredicate) => {
		const { sql } = compileUnion(journeyFacetsQuery(ALL_FILTERS), listParams)
		const branch = sql.split("UNION ALL").find((b) => b.includes(marker))!
		expect(branch, `no branch matched ${marker}`).toBeDefined()
		expect(havingOf(branch)).not.toContain(ownPredicate)
	})

	it.each(FACET_BRANCHES)("the %s branch keeps every other dimension's predicate", (_n, marker, own) => {
		const { sql } = compileUnion(journeyFacetsQuery(ALL_FILTERS), listParams)
		const branch = havingOf(sql.split("UNION ALL").find((b) => b.includes(marker))!)
		// The four numeric range filters are one exclusion group by design (they
		// share a scan), so a numeric branch legitimately drops all of them.
		const numericGroup = ["durationMs >= 1000"]
		const isNumericBranch = numericGroup.includes(own)
		for (const [, , predicate] of FACET_BRANCHES) {
			if (predicate === own) continue
			if (isNumericBranch && numericGroup.includes(predicate)) continue
			expect(branch, `${marker} dropped someone else's predicate: ${predicate}`).toContain(predicate)
		}
	})

	// Every branch re-runs the whole journey aggregate, so the eight numeric
	// percentiles share ONE pass and are unpacked with a single arrayJoin.
	it("computes all numeric percentiles in one branch", () => {
		const { sql } = compileUnion(journeyFacetsQuery(), listParams)
		const statBranches = sql.split("UNION ALL").filter((b) => b.includes("quantile(0.95)"))
		expect(statBranches).toHaveLength(1)
		expect(sql).toContain("tuple('p95', 'durationStat'")
		expect(sql).toContain("tuple('p50', 'costStat'")
	})

	// Cost percentiles ride the UNION's integer count column, so a $0.004 p95
	// would round to zero without the micro-dollar scaling.
	it("scales cost percentiles to micro-dollars and gates them on cost presence", () => {
		const { sql } = compileUnion(journeyFacetsQuery(), listParams)
		expect(sql).toContain("quantileIf(0.95)(cost, costSpanCount > 0) * 1000000")
	})

	it("keeps every branch org-scoped", () => {
		expect(compileUnion(journeyFacetsQuery(), listParams).tenantScope).toBe("org")
	})
})
