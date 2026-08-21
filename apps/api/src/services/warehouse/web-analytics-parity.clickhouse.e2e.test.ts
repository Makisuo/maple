// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Raw-vs-rollup parity for web analytics.
//
// `web_events` is a performance change, not a semantics change: every one of the
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
//     network rows must never reach `web_events`, and custom rows must.

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
 * `session_events` and `web_events` both carry a 30-day TTL, and ClickHouse
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

	const sessionRows = SEED_SESSIONS.map(
		(row) =>
			`(${quote(ORG_ID)}, ${quote(row.sessionId)}, ${quote(row.startTime)}, ${row.durationMs}, ${row.pageViews}, ${row.version}, ${quote(row.visitorId)}, ${row.visitorIsNew}, ${quote(row.referrerHost)}, ${quote(row.country)}, ${quote(row.deviceType)}, ${quote(row.browserName)}, ${quote(row.osName)}, ${quote(row.language)}, ${quote(row.utmSource)}, ${quote(row.host)}, ${quote(row.entryPath)}, ${quote(row.exitPath)})`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO session_replays (OrgId, SessionId, StartTime, DurationMs, PageViews, Version, VisitorId, VisitorIsNew, ReferrerHost, Country, DeviceType, BrowserName, OsName, Language, UtmSource, Host, EntryPath, ExitPath) VALUES\n${sessionRows}`,
		database,
	)
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
	assert.include(rollupSql, "FROM web_events", "the rollup variant does not read web_events")
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
		compile: (filters) => CH.compile(CH.webAnalyticsSummaryQuery(filters), window).sql,
	},
	{
		name: "webAnalyticsTimeseries",
		compile: (filters) =>
			CH.compile(CH.webAnalyticsTimeseriesQuery({ ...filters, bucketSeconds: 3600 }), window).sql,
	},
	{
		name: "webAnalyticsPageviews",
		compile: (filters) =>
			CH.compile(CH.webAnalyticsPageviewsTimeseriesQuery({ ...filters, bucketSeconds: 3600 }), window)
				.sql,
	},
	{
		name: "webAnalyticsPages",
		compile: (filters) => CH.compile(CH.webAnalyticsPagesQuery({ ...filters, limit: 100 }), window).sql,
	},
	{
		name: "webAnalyticsEvents",
		compile: (filters) => CH.compile(CH.webAnalyticsEventsQuery({ ...filters, limit: 100 }), window).sql,
	},
	{
		name: "webAnalyticsBreakdowns",
		compile: (filters) =>
			CH.compileUnion(CH.webAnalyticsBreakdownsQuery({ ...filters, limitPerDimension: 50 }), window)
				.sql,
	},
]

describe.skipIf(!clickhouseE2eEnabled)("web analytics raw-vs-rollup parity", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

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

	it("populates web_events from the materialized view with only navigation and custom rows", async () => {
		const rows = await runJson("SELECT Kind, count() AS n FROM web_events GROUP BY Kind ORDER BY Kind")
		const byKind = Object.fromEntries(rows.map((row) => [String(row.Kind), Number(row.n)]))
		const expectedNavigation = SEED_EVENTS.filter((row) => row.type === "navigation").length
		const expectedCustom = SEED_EVENTS.filter((row) => row.type === "custom").length
		assert.deepStrictEqual(byKind, { custom: expectedCustom, navigation: expectedNavigation })

		// The reserved-name collision lands as a custom row, not a page view.
		const collision = await runJson(
			"SELECT Kind FROM web_events WHERE EventName = '$pageview' AND Kind = 'custom'",
		)
		assert.lengthOf(collision, 1, "track('$pageview') must stay a custom event")
	})

	it("pre-extracts Host and PagePath exactly as the read-time functions would", async () => {
		const drift = await runJson(
			`SELECT count() AS n
			 FROM web_events
			 WHERE Host != domain(Url) OR PagePath != path(Url)`,
		)
		assert.strictEqual(Number(drift[0]?.n), 0, "write-time URL parsing diverged from read-time")
	})

	// A `for` loop, not `describe.each`: the latter OOMs tsc in this repo.
	for (const query of QUERIES) {
		for (const filterCase of FILTER_CASES) {
			it(`${query.name} agrees across sources — ${filterCase.label}`, async () => {
				const rawSql = query.compile({ ...filterCase.filters, useWebEvents: false })
				const rollupSql = query.compile({ ...filterCase.filters, useWebEvents: true })
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
