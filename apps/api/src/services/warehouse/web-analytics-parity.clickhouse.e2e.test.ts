// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Raw-vs-rollup parity for web analytics.
//
// `product_events` is a performance change, not a semantics change: every one of the
// five web-analytics queries must return byte-identical numbers whether it reads
// raw `session_events` or the rollup. The analyzer sweep next door proves the
// rollup SQL *parses*; only running both against the same rows proves they
// AGREE, and disagreement here is invisible in production — the page renders a
// plausible number either way.
//
// The failure modes this is shaped to catch:
//
//   - `Kind` drifting from `Type`. A customer calling `track('$pageview')` must
//     not become a page view, which is why the discriminator is the carried-through
//     `Type` and not `EventName`. The seed includes exactly that row.
//   - `domain(Url)`/`path(Url)` at read time disagreeing with the same functions
//     evaluated at write time inside the MV — URLs with ports, query strings,
//     fragments, trailing slashes, and unparseable junk are all seeded.
//   - The navigation semi-join changing which sessions it selects, which is the
//     path the breakdown fan-out inlines twelve times.
//   - The MV's WHERE dropping or admitting the wrong event types: clicks and
//     network rows must never reach `product_events`, and custom rows must.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_web_analytics_parity_e2e")
const ORG_ID = "org_web_analytics_parity"

/**
 * The seed window is anchored to *now*, not to a fixed calendar date.
 *
 * `session_events` carries a 30-day TTL (`product_events` a longer one), and ClickHouse
 * enforces it at insert time — a hardcoded date silently drops every seeded row
 * the moment it ages past the horizon, both tables end up empty, and every
 * comparison below passes by comparing nothing to nothing. This test was written
 * with a fixed date first and did exactly that; `seeds land in both tables` is
 * the assertion that caught it and the reason it exists.
 */
const DAY_MS = 86_400_000
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
/** Midnight, three days back — comfortably inside the TTL horizon on both ends. */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
const at = (offsetMs: number): string => chDateTime(BASE_MS + offsetMs)

const START_TIME = at(0)
const END_TIME = at(DAY_MS)

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/**
 * One `session_events` row. `Seq` matters: it is the tiebreaker inside a
 * millisecond and part of the rollup's sorting key.
 */
interface SeedEvent {
	readonly sessionId: string
	readonly ts: string
	readonly seq: number
	readonly type: string
	readonly url: string
	readonly message?: string
}

const ev = (
	sessionId: string,
	ts: string,
	seq: number,
	type: string,
	url: string,
	message = "",
): SeedEvent => ({ sessionId, ts, seq, type, url, message })

// Four sessions with deliberately awkward URLs. s1/s2 are on maple.dev, s3 on
// app.maple.dev, s4 has a row whose Url does not parse at all.
const SEED_EVENTS: ReadonlyArray<SeedEvent> = [
	ev("s1", at(HOUR_MS), 0, "navigation", "https://maple.dev/"),
	ev("s1", at(HOUR_MS + 1000), 1, "click", "https://maple.dev/"),
	ev("s1", at(HOUR_MS + MINUTE_MS), 2, "navigation", "https://maple.dev/pricing?plan=pro#faq"),
	ev("s1", at(HOUR_MS + 2 * MINUTE_MS), 3, "custom", "https://maple.dev/pricing", "signup_started"),
	// A customer-named event colliding with the reserved page-view name. If the
	// rollup discriminated on EventName instead of Kind, this would inflate page
	// views on the rollup path only.
	ev("s1", at(HOUR_MS + 3 * MINUTE_MS), 4, "custom", "https://maple.dev/pricing", "$pageview"),
	ev("s2", at(2 * HOUR_MS), 0, "navigation", "https://maple.dev/pricing"),
	ev("s2", at(2 * HOUR_MS + 30_000), 1, "network", "https://maple.dev/api/x"),
	ev("s2", at(2 * HOUR_MS + MINUTE_MS), 2, "navigation", "https://maple.dev:8443/docs/"),
	ev("s3", at(3 * HOUR_MS), 0, "navigation", "https://app.maple.dev/dashboard"),
	ev("s3", at(3 * HOUR_MS + 5000), 1, "console", "https://app.maple.dev/dashboard"),
	ev("s3", at(3 * HOUR_MS + 30 * MINUTE_MS), 0, "navigation", "https://app.maple.dev/dashboard"),
	ev("s4", at(4 * HOUR_MS), 0, "navigation", "not-a-url"),
	ev("s4", at(4 * HOUR_MS + 10_000), 1, "navigation", ""),
	ev("s4", at(4 * HOUR_MS + MINUTE_MS), 2, "custom", "not-a-url", "checkout_completed"),
	// Outside the query window on both ends — catches a bound that shifted when
	// the time column moved into the sorting-key prefix.
	ev("s1", at(-1000), 9, "navigation", "https://maple.dev/early"),
	ev("s2", at(DAY_MS + 1000), 9, "navigation", "https://maple.dev/late"),
]

/** A session_replays row. Seeded as v1+v2 pairs for some sessions and v1-only
 * for others, so the `uniq(SessionId)` discipline is actually under test. */
interface SeedSession {
	readonly sessionId: string
	readonly version: number
	readonly pageViews: number
	readonly durationMs: string
	readonly visitorId: string
	readonly visitorIsNew: number
	readonly referrerHost: string
	readonly country: string
	readonly deviceType: string
	readonly browserName: string
	readonly osName: string
	readonly language: string
	readonly utmSource: string
	readonly host: string
	readonly entryPath: string
	readonly exitPath: string
	readonly startTime: string
}

const sess = (sessionId: string, version: number, overrides: Partial<SeedSession> = {}): SeedSession => ({
	sessionId,
	version,
	pageViews: 0,
	durationMs: "NULL",
	visitorId: "",
	visitorIsNew: 0,
	referrerHost: "",
	country: "",
	deviceType: "",
	browserName: "",
	osName: "",
	language: "",
	utmSource: "",
	host: "",
	entryPath: "",
	exitPath: "",
	startTime: at(HOUR_MS),
	...overrides,
})

const IDENTIFIED = {
	visitorId: "v1",
	visitorIsNew: 1,
	referrerHost: "t.co",
	country: "DE",
	deviceType: "desktop",
	browserName: "Chrome",
	osName: "macOS",
	language: "en-US",
	utmSource: "twitter",
	host: "maple.dev",
	entryPath: "/",
	exitPath: "/pricing",
} as const

const SEED_SESSIONS: ReadonlyArray<SeedSession> = [
	// v1 + v2 for the same session: the un-merged pair every count has to dedupe.
	sess("s1", 1, { ...IDENTIFIED, startTime: at(HOUR_MS) }),
	sess("s1", 2, {
		...IDENTIFIED,
		startTime: at(HOUR_MS),
		pageViews: 2,
		durationMs: "180000",
	}),
	sess("s2", 1, {
		visitorId: "v2",
		country: "US",
		deviceType: "mobile",
		browserName: "Safari",
		osName: "iOS",
		language: "en-GB",
		host: "maple.dev",
		entryPath: "/pricing",
		exitPath: "/docs/",
		startTime: at(2 * HOUR_MS),
	}),
	sess("s2", 2, {
		visitorId: "v2",
		country: "US",
		deviceType: "mobile",
		browserName: "Safari",
		osName: "iOS",
		language: "en-GB",
		host: "maple.dev",
		entryPath: "/pricing",
		exitPath: "/docs/",
		startTime: at(2 * HOUR_MS),
		pageViews: 2,
		durationMs: "60000",
	}),
	// v1 only — the in-progress session that must not vanish from either side of
	// the bounce ratio.
	sess("s3", 1, {
		visitorId: "v3",
		country: "DE",
		deviceType: "desktop",
		browserName: "Firefox",
		osName: "Linux",
		startTime: at(3 * HOUR_MS),
	}),
	// No analytics block at all: the pre-migration-0011 SDK build. Page views
	// still count for it, which is the whole reason host/pagePath semi-join
	// through the event table rather than filtering EntryPath.
	sess("s4", 1, { startTime: at(4 * HOUR_MS) }),
]

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const seed = async (): Promise<void> => {
	const eventRows = SEED_EVENTS.map(
		(row) =>
			`(${quote(ORG_ID)}, ${quote(row.sessionId)}, ${quote(row.ts)}, ${row.seq}, ${quote(row.type)}, ${quote(row.url)}, ${quote(row.message ?? "")}, map())`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO session_events (OrgId, SessionId, Timestamp, Seq, Type, Url, Message, Attributes) VALUES\n${eventRows}`,
		database,
	)

	// One INSERT per version, with merges held off. `optimize_on_insert` is on by
	// default, so a single block collapses a ReplacingMergeTree's duplicates
	// before they are ever visible — seeding that way leaves this suite asserting
	// over pre-deduplicated rows, which is the one state it exists to rule out.
	await clickhouseExec(`SYSTEM STOP MERGES session_replays`, database)
	for (const version of [...new Set(SEED_SESSIONS.map((row) => row.version))].sort()) {
		const sessionRows = SEED_SESSIONS.filter((row) => row.version === version)
			.map(
				(row) =>
					`(${quote(ORG_ID)}, ${quote(row.sessionId)}, ${quote(row.startTime)}, ${row.durationMs}, ${row.pageViews}, ${row.version}, ${quote(row.visitorId)}, ${row.visitorIsNew}, ${quote(row.referrerHost)}, ${quote(row.country)}, ${quote(row.deviceType)}, ${quote(row.browserName)}, ${quote(row.osName)}, ${quote(row.language)}, ${quote(row.utmSource)}, ${quote(row.host)}, ${quote(row.entryPath)}, ${quote(row.exitPath)})`,
			)
			.join(",\n")
		await clickhouseExec(
			`INSERT INTO session_replays (OrgId, SessionId, StartTime, DurationMs, PageViews, Version, VisitorId, VisitorIsNew, ReferrerHost, Country, DeviceType, BrowserName, OsName, Language, UtmSource, Host, EntryPath, ExitPath) VALUES\n${sessionRows}`,
			database,
		)
	}
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	// `normalizeSqlForClickHouseClient` strips the trailing `FORMAT JSON` — the
	// official client sets the format itself — so ask for it as a setting instead
	// of leaving the server on its TabSeparated default.
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

/**
 * The two variants must differ exactly when the query reaches a page-view source
 * at all. Summary, visitor timeseries and breakdowns read `session_replays` and
 * only touch the page-view table through the navigation semi-join — with no
 * host/pagePath filter there is no semi-join, so identical SQL is the correct
 * outcome and asserting otherwise would be asserting a bug.
 */
const assertSourcesSwapped = (rawSql: string, rollupSql: string): void => {
	if (!rawSql.includes("FROM session_events")) {
		assert.strictEqual(
			rollupSql,
			rawSql,
			"a query that reads no page-view source must compile identically in both variants",
		)
		return
	}
	assert.notInclude(rollupSql, "FROM session_events", "the rollup variant still reads the raw table")
	assert.include(rollupSql, "FROM product_events", "the rollup variant does not read product_events")
}

/** Order-insensitive comparison keyed on the row's dimension columns — the
 * `ORDER BY count DESC` tie-break is not stable, and a tie flipping is not a
 * parity failure. */
const canonical = (rows: ReadonlyArray<Record<string, unknown>>): string =>
	JSON.stringify([...rows].map((row) => JSON.stringify(row)).sort())

/** The filter matrix. Each entry is applied to all five queries in both variants. */
const FILTER_CASES: ReadonlyArray<{ readonly label: string; readonly filters: CH.WebAnalyticsFilters }> = [
	{ label: "unfiltered", filters: {} },
	{ label: "host-only", filters: { host: "maple.dev" } },
	{ label: "pagePath-only", filters: { pagePath: "/pricing" } },
	{ label: "host+pagePath", filters: { host: "maple.dev", pagePath: "/pricing" } },
	// Forces the reverse semi-join: a session_replays-only dimension has to
	// narrow the page-view source through a subquery.
	{ label: "replays-dimension", filters: { country: "DE" } },
	{ label: "replays-dimension+path", filters: { country: "DE", pagePath: "/pricing" } },
	// The event semi-join, alone and composed with a page filter.
	{ label: "event", filters: { eventName: "signup_started" } },
	{ label: "event+path", filters: { eventName: "signup_started", pagePath: "/pricing" } },
	{
		label: "all-dimensions",
		filters: {
			host: "maple.dev",
			pagePath: "/pricing",
			referrerHost: "t.co",
			country: "DE",
			deviceType: "desktop",
			browserName: "Chrome",
			osName: "macOS",
			language: "en-US",
			utmSource: "twitter",
			visitorType: "new",
			eventName: "signup_started",
		},
	},
]

const QUERIES: ReadonlyArray<{
	readonly name: string
	readonly compile: (filters: CH.WebAnalyticsFilters) => string
}> = [
	{
		name: "webAnalyticsSummary",
		compile: (filters) => CH.compileUnsafe(CH.webAnalyticsSummaryQuery(filters), window).sql,
	},
	{
		// The recency test is relative to the `endTime` param, not `now()`, so the
		// fixed fixture window pins it as firmly as every other query here.
		name: "webAnalyticsLive",
		compile: (filters) => CH.compileUnsafe(CH.webAnalyticsLiveQuery(filters), window).sql,
	},
	{
		name: "webAnalyticsTimeseries",
		compile: (filters) =>
			CH.compileUnsafe(CH.webAnalyticsTimeseriesQuery({ ...filters, bucketSeconds: 3600 }), window).sql,
	},
	{
		name: "webAnalyticsPageviews",
		compile: (filters) =>
			CH.compileUnsafe(
				CH.webAnalyticsPageviewsTimeseriesQuery({ ...filters, bucketSeconds: 3600 }),
				window,
			).sql,
	},
	{
		name: "webAnalyticsPages",
		compile: (filters) =>
			CH.compileUnsafe(CH.webAnalyticsPagesQuery({ ...filters, limit: 100 }), window).sql,
	},
	{
		name: "webAnalyticsEvents",
		compile: (filters) =>
			CH.compileUnsafe(CH.webAnalyticsEventsQuery({ ...filters, limit: 100 }), window).sql,
	},
	{
		name: "webAnalyticsBreakdowns",
		compile: (filters) =>
			CH.compileUnionUnsafe(
				CH.webAnalyticsBreakdownsQuery({ ...filters, limitPerDimension: 50 }),
				window,
			).sql,
	},
]

// One database for both suites in this file — migrations are the slow part.
// File-level so the parity suite's teardown cannot run before the funnel suite
// below has started; guarded because file-level hooks run even when every
// `describe` is skipped.
if (clickhouseE2eEnabled) {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)
}

describe.skipIf(!clickhouseE2eEnabled)("web analytics raw-vs-rollup parity", () => {
	it("seeds land in both tables", async () => {
		// The guard against a vacuous suite. Every comparison below is an equality
		// between two result sets, so two empty result sets pass every one of them —
		// which is precisely what a TTL-expired seed produces, silently.
		const [events, replays] = await Promise.all([
			runJson("SELECT count() AS n FROM session_events"),
			runJson("SELECT uniq(SessionId) AS n FROM session_replays"),
		])
		assert.strictEqual(
			Number(events[0]?.n),
			SEED_EVENTS.length,
			"session_events seed did not land — check the rows against the table's 30-day TTL",
		)
		// Distinct sessions, not rows: session_replays is a ReplacingMergeTree and a
		// background merge may already have collapsed the v1/v2 pairs, so the raw
		// row count is 4 or 6 depending on timing. That nondeterminism is exactly
		// why every count over that table is `uniq(SessionId)`.
		const distinct = new Set(SEED_SESSIONS.map((row) => row.sessionId)).size
		assert.strictEqual(
			Number(replays[0]?.n),
			distinct,
			"session_replays seed did not land — check the rows against the table's 30-day TTL",
		)
	})

	it("populates product_events from the materialized view with only navigation and custom rows", async () => {
		const rows = await runJson(
			"SELECT Kind, count() AS n FROM product_events GROUP BY Kind ORDER BY Kind",
		)
		const byKind = Object.fromEntries(rows.map((row) => [String(row.Kind), Number(row.n)]))
		const expectedNavigation = SEED_EVENTS.filter((row) => row.type === "navigation").length
		const expectedCustom = SEED_EVENTS.filter((row) => row.type === "custom").length
		assert.deepStrictEqual(byKind, { custom: expectedCustom, navigation: expectedNavigation })

		// The reserved-name collision lands as a custom row, not a page view.
		const collision = await runJson(
			"SELECT Kind FROM product_events WHERE EventName = '$pageview' AND Kind = 'custom'",
		)
		assert.lengthOf(collision, 1, "track('$pageview') must stay a custom event")
	})

	it("pre-extracts Host and PagePath exactly as the read-time functions would", async () => {
		const drift = await runJson(
			`SELECT count() AS n
			 FROM product_events
			 WHERE Host != domain(Url) OR PagePath != path(Url)`,
		)
		assert.strictEqual(Number(drift[0]?.n), 0, "write-time URL parsing diverged from read-time")
	})

	/**
	 * Parity is an equality between two sources, so it holds just as well when
	 * both are wrong. `session_replays` is a `ReplacingMergeTree(Version)` and the
	 * seed's s1/s2 carry an un-merged v1 (`PageViews = 0`) beside a v2 reporting
	 * two page views: a `uniqIf(SessionId, PageViews <= 1)` matches on the v1 row
	 * and calls every one of them a bounce.
	 */
	it("counts a bounce from the session's latest version, not any version", async () => {
		const rows = await runJson(
			CH.compileUnsafe(CH.webAnalyticsSummaryQuery({ useProductEvents: false }), window).sql,
		)
		const row = rows[0]
		assert.isDefined(row, "summary returned no rows")
		// s1 and s2 ended on two page views; only s3, still on its start row, is a
		// bounce. s4 carries no VisitorId and is outside the measured population.
		assert.strictEqual(Number(row?.identifiedSessions), 3)
		assert.strictEqual(Number(row?.bouncedSessions), 1)
	})

	// A `for` loop, not `describe.each`: the latter OOMs tsc in this repo.
	for (const query of QUERIES) {
		for (const filterCase of FILTER_CASES) {
			it(`${query.name} agrees across sources — ${filterCase.label}`, async () => {
				const rawSql = query.compile({ ...filterCase.filters, useProductEvents: false })
				const rollupSql = query.compile({ ...filterCase.filters, useProductEvents: true })
				assertSourcesSwapped(rawSql, rollupSql)

				const [rawRows, rollupRows] = await Promise.all([runJson(rawSql), runJson(rollupSql)])
				// Equality between two empty result sets is not evidence of parity.
				// The unfiltered case must always return rows; the filtered ones are
				// allowed to be empty only if the raw side is too, which the equality
				// below already covers.
				if (filterCase.label === "unfiltered")
					assert.isNotEmpty(
						rawRows,
						`${query.name} returned no rows unfiltered — the seed is not reaching it`,
					)
				assert.strictEqual(
					canonical(rollupRows),
					canonical(rawRows),
					`${query.name} disagreed under ${filterCase.label}`,
				)
			})
		}
	}
})

// Funnels over product_events.
//
// Not a raw-vs-rollup parity — funnels have no raw counterpart, since server
// rows exist only in `product_events`. What is under test is the arithmetic:
// per-step counts computed by hand from a small seed versus what the compiled
// SQL returns, across every person-key resolution, the session-step branch, the
// window bound, and both breakdown sources.
//
// The seed is its own org so the web-analytics counts above are untouched:
//   f1  v1 (anonymous)   referred by t.co / twitter   /  → /pricing → signup_started
//   f2  v2               referred by t.co             /  → /pricing
//   f3  v3               referred by google.com       /pricing
//   f5  v1 + u1          direct (identified later)    /dashboard      ← links v1 → u1
//   server rows: plan_started for u1 (plan=startup) and for u9 (unlinked)

const FUNNEL_ORG_ID = "org_funnel_parity"
const funnelWindow = { orgId: FUNNEL_ORG_ID, startTime: START_TIME, endTime: END_TIME }

interface FunnelSeedEvent extends SeedEvent {
	readonly visitorId: string
	readonly userId: string
}

const fev = (
	sessionId: string,
	visitorId: string,
	userId: string,
	ts: string,
	seq: number,
	type: string,
	url: string,
	message = "",
): FunnelSeedEvent => ({ sessionId, visitorId, userId, ts, seq, type, url, message })

const FUNNEL_EVENTS: ReadonlyArray<FunnelSeedEvent> = [
	fev("f1", "v1", "", at(HOUR_MS), 0, "navigation", "https://maple.dev/"),
	fev("f1", "v1", "", at(HOUR_MS + MINUTE_MS), 1, "navigation", "https://maple.dev/pricing"),
	fev(
		"f1",
		"v1",
		"",
		at(HOUR_MS + 2 * MINUTE_MS),
		2,
		"custom",
		"https://maple.dev/pricing",
		"signup_started",
	),
	fev("f2", "v2", "", at(2 * HOUR_MS), 0, "navigation", "https://maple.dev/"),
	fev("f2", "v2", "", at(2 * HOUR_MS + MINUTE_MS), 1, "navigation", "https://maple.dev/pricing"),
	fev("f3", "v3", "", at(3 * HOUR_MS), 0, "navigation", "https://maple.dev/pricing"),
	fev("f5", "v1", "u1", at(5 * HOUR_MS), 0, "navigation", "https://app.maple.dev/dashboard"),
]

const FUNNEL_SESSIONS: ReadonlyArray<SeedSession> = [
	sess("f1", 1, {
		visitorId: "v1",
		referrerHost: "t.co",
		utmSource: "twitter",
		country: "DE",
		startTime: at(HOUR_MS),
	}),
	sess("f2", 1, { visitorId: "v2", referrerHost: "t.co", country: "US", startTime: at(2 * HOUR_MS) }),
	sess("f3", 1, { visitorId: "v3", referrerHost: "google.com", country: "DE", startTime: at(3 * HOUR_MS) }),
	sess("f5", 1, { visitorId: "v1", startTime: at(5 * HOUR_MS) }),
]

const seedFunnel = async (): Promise<void> => {
	const eventRows = FUNNEL_EVENTS.map(
		(row) =>
			`(${quote(FUNNEL_ORG_ID)}, ${quote(row.sessionId)}, ${quote(row.ts)}, ${row.seq}, ${quote(row.type)}, ${quote(row.url)}, ${quote(row.message ?? "")}, map(), ${quote(row.visitorId)}, ${quote(row.userId)})`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO session_events (OrgId, SessionId, Timestamp, Seq, Type, Url, Message, Attributes, VisitorId, UserId) VALUES\n${eventRows}`,
		database,
	)
	// f5 carries UserId so identity_links_mv links v1 → u1.
	const sessionRows = FUNNEL_SESSIONS.map(
		(row) =>
			`(${quote(FUNNEL_ORG_ID)}, ${quote(row.sessionId)}, ${quote(row.startTime)}, ${row.version}, ${quote(row.visitorId)}, ${quote(row.sessionId === "f5" ? "u1" : "")}, ${quote(row.referrerHost)}, ${quote(row.country)}, ${quote(row.utmSource)})`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO session_replays (OrgId, SessionId, StartTime, Version, VisitorId, UserId, ReferrerHost, Country, UtmSource) VALUES\n${sessionRows}`,
		database,
	)
	await clickhouseExec(
		`INSERT INTO product_events (OrgId, Timestamp, Source, UserId, Kind, EventName, ServiceName, Attributes) VALUES
		 (${quote(FUNNEL_ORG_ID)}, ${quote(at(6 * HOUR_MS))}, 'server', 'u1', 'custom', 'plan_started', 'maple-api', map('plan', 'startup')),
		 (${quote(FUNNEL_ORG_ID)}, ${quote(at(6 * HOUR_MS + MINUTE_MS))}, 'server', 'u9', 'custom', 'plan_started', 'maple-api', map('plan', 'free'))`,
		database,
	)
}

const REFERRAL_STEPS: ReadonlyArray<CH.FunnelStep> = [
	{ kind: "session", dimension: "referrerHost", value: "t.co" },
	{ kind: "page", pagePath: "/pricing" },
	{ kind: "event", eventName: "plan_started" },
]
const PRODUCT_STEPS: ReadonlyArray<CH.FunnelStep> = [
	{ kind: "page", pagePath: "/pricing", host: "maple.dev" },
	{ kind: "event", eventName: "signup_started" },
	{ kind: "event", eventName: "plan_started", attributeEquals: { plan: "startup" } },
]

const funnelCounts = async (opts: CH.ProductEventsFunnelOpts): Promise<ReadonlyArray<number>> => {
	const rows = await runJson(CH.compileUnsafe(CH.productEventsFunnelQuery(opts), funnelWindow).sql)
	return rows.map((row) => Number(row.count))
}

const breakdownRows = async (
	opts: CH.ProductEventsFunnelBreakdownOpts,
): Promise<ReadonlyArray<[unknown, number, number]>> => {
	const rows = await runJson(CH.compileUnsafe(CH.productEventsFunnelBreakdownQuery(opts), funnelWindow).sql)
	return rows.map((row) => [row.group, Number(row.step), Number(row.count)])
}

describe.skipIf(!clickhouseE2eEnabled)("product events funnels", () => {
	beforeAll(async () => {
		// Shares the database (and its migrations) with the parity suite above; the
		// seed is a different org so neither suite can see the other's rows.
		await seedFunnel()
	}, 60_000)

	it("seeds land in product_events and identity_links", async () => {
		const [events, links] = await Promise.all([
			runJson(`SELECT count() AS n FROM product_events WHERE OrgId = ${quote(FUNNEL_ORG_ID)}`),
			runJson(
				`SELECT VisitorId, UserId FROM identity_links WHERE OrgId = ${quote(FUNNEL_ORG_ID)} GROUP BY VisitorId, UserId`,
			),
		])
		assert.strictEqual(
			Number(events[0]?.n),
			FUNNEL_EVENTS.length + 2,
			"browser rows via the MV plus two server rows",
		)
		assert.deepStrictEqual(links, [{ VisitorId: "v1", UserId: "u1" }])
	})

	it("stitches a referred anonymous visit to the same person's server-side event", async () => {
		// u1 (via v1): entry H1 → /pricing H1+1m → plan_started H6. v2: entry → /pricing.
		assert.deepStrictEqual(
			await funnelCounts({ steps: REFERRAL_STEPS, keyBy: "person", windowSeconds: 86_400 }),
			[2, 2, 1],
		)
	})

	it("cannot reach the server-side step on a visitor or session key", async () => {
		assert.deepStrictEqual(
			await funnelCounts({ steps: REFERRAL_STEPS, keyBy: "visitor", windowSeconds: 86_400 }),
			[2, 2, 0],
		)
		assert.deepStrictEqual(
			await funnelCounts({ steps: REFERRAL_STEPS, keyBy: "session", windowSeconds: 86_400 }),
			[2, 2, 0],
		)
	})

	it("enforces the window from the step-1 event", async () => {
		// plan_started is 5h after the referred entry: inside a day, outside an hour.
		assert.deepStrictEqual(
			await funnelCounts({ steps: REFERRAL_STEPS, keyBy: "person", windowSeconds: 3_600 }),
			[2, 2, 0],
		)
	})

	it("counts persons in step order and ignores later steps without a step-1 event", async () => {
		// u1: /pricing → signup_started → plan_started(startup) = 3. v2, v3: /pricing = 1.
		// u9: plan_started only, no step 1 → 0.
		assert.deepStrictEqual(
			await funnelCounts({ steps: PRODUCT_STEPS, keyBy: "person", windowSeconds: 86_400 }),
			[3, 1, 1],
		)
	})

	it("narrows the population by person when a filter is set", async () => {
		// country=DE keeps f1 (→ u1) and f3 (v3); v2 (US) drops out entirely.
		assert.deepStrictEqual(
			await funnelCounts({
				steps: PRODUCT_STEPS,
				keyBy: "person",
				windowSeconds: 86_400,
				filters: { country: "DE" },
			}),
			[2, 1, 1],
		)
	})

	it("breaks a funnel down by a session dimension read through the person's sessions", async () => {
		assert.deepStrictEqual(
			await breakdownRows({
				steps: PRODUCT_STEPS,
				keyBy: "person",
				windowSeconds: 86_400,
				breakdownBy: "referrerHost",
			}),
			[
				["google.com", 1, 1],
				["google.com", 2, 0],
				["google.com", 3, 0],
				["t.co", 1, 2],
				["t.co", 2, 1],
				["t.co", 3, 1],
			],
		)
	})

	it("breaks a funnel down by an event attribute", async () => {
		assert.deepStrictEqual(
			await breakdownRows({
				steps: [{ kind: "event", eventName: "plan_started" }],
				keyBy: "user",
				windowSeconds: 60,
				breakdownBy: "attribute:plan",
			}),
			[
				["free", 1, 1],
				["startup", 1, 1],
			],
		)
	})

	it("lists event names with counts, sessions and persons", async () => {
		const rows = await runJson(
			CH.compileUnsafe(CH.productEventNamesQuery({ limit: 10 }), funnelWindow).sql,
		)
		assert.deepStrictEqual(
			rows.map((row) => [
				row.eventName,
				row.kind,
				Number(row.count),
				Number(row.sessions),
				Number(row.persons),
			]),
			[
				["$pageview", "navigation", 6, 4, 4],
				["plan_started", "custom", 2, 0, 2],
				["signup_started", "custom", 1, 1, 1],
			],
		)
	})
})
