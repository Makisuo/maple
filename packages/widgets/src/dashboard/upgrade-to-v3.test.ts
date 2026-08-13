import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	dataSourceEndpoint,
	dataSourceQuerySet,
	dataSourceRawSql,
	dataSourceRouteParams,
	dataSourceTransform,
} from "./access"
import { MARKDOWN_STATIC_ENDPOINT, QUERY_SHAPE_ENDPOINTS, RAW_SQL_ENDPOINT } from "./legacy-endpoints"
import { DashboardDocumentV3 } from "./v3/document"
import { isDocumentV3, upgradeDocumentToV3 } from "./upgrade-to-v3"

const query = { id: "a", name: "A", dataSource: "traces", aggregation: "count" }

/** One v2 data source per legacy endpoint family — the full input space. */
const V2_SOURCES: ReadonlyArray<{ label: string; source: Record<string, unknown> }> = [
	...Object.entries(QUERY_SHAPE_ENDPOINTS).map(([shape, endpoint]) => ({
		label: `query/${shape}`,
		source: {
			endpoint,
			params: {
				queries: [query],
				formulas: [{ id: "f", name: "F", expression: "a * 2", legend: "F" }],
				defaultLimit: 20,
				limit: 5,
				columns: ["a", "b"],
			},
			transform: { reduceToValue: { field: "value", aggregate: "first" } },
		},
	})),
	{
		label: "raw_sql",
		source: {
			endpoint: RAW_SQL_ENDPOINT,
			params: { sql: "SELECT 1 WHERE $__orgFilter", displayType: "line", granularitySeconds: 60 },
		},
	},
	{
		label: "route",
		source: { endpoint: "service_overview", params: { serviceName: "api" } },
	},
	{
		label: "route without params",
		source: { endpoint: "list_traces" },
	},
	{
		label: "static",
		source: { endpoint: MARKDOWN_STATIC_ENDPOINT },
	},
]

const documentWith = (dataSource: unknown, display: unknown = { title: "T" }) => ({
	id: "3f1b7c62-5a1e-4d0f-9a3b-6c2e8d4f1a90",
	schemaVersion: 2,
	name: "Board",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "widget-1",
			visualization: "chart",
			dataSource,
			display,
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
})

/**
 * `upgradeDocumentToV3` returns `unknown` on purpose — it takes raw stored JSON
 * and makes no promise about a document it did not understand. These two helpers
 * do the narrowing once, so no assertion below has to.
 */
const upgraded = (document: unknown): Record<string, unknown> => {
	const result = upgradeDocumentToV3(document)
	if (typeof result !== "object" || result === null) throw new Error("expected an object")
	return result as Record<string, unknown>
}

const firstWidget = (document: unknown): Record<string, unknown> => {
	const widgets = upgraded(document).widgets
	if (!Array.isArray(widgets)) throw new Error("expected widgets to be an array")
	const [widget] = widgets
	if (typeof widget !== "object" || widget === null) throw new Error("expected a widget object")
	return widget as Record<string, unknown>
}

const migratedSource = (dataSource: unknown): unknown => firstWidget(documentWith(dataSource)).dataSource

describe("the v3 upgrade preserves meaning", () => {
	// The strongest assertion available, and it is nearly free: `access.ts` reads
	// BOTH shapes, so asserting that every accessor returns the same answer before
	// and after literally says "the transform changed the envelope, not the
	// content". If this passes for every input family, the ~30 consumers already
	// on the accessors cannot observe the flip.
	it.each(V2_SOURCES)("$label reads identically through every accessor", ({ source }) => {
		const v3 = migratedSource(source)

		expect(dataSourceQuerySet(v3)).toEqual(dataSourceQuerySet(source))
		expect(dataSourceRawSql(v3)).toEqual(dataSourceRawSql(source))
		expect(dataSourceRouteParams(v3)).toEqual(dataSourceRouteParams(source))
		expect(dataSourceTransform(v3)).toEqual(dataSourceTransform(source))
	})

	// The one deliberate exception, asserted so it cannot regress silently: a v3
	// query/raw_sql source has NO endpoint, and `dataSourceEndpoint` returns null
	// rather than inventing one. Inventing it would re-create the string-sniffing
	// the union removes.
	it.each(V2_SOURCES)("$label reports an endpoint only when it is a route", ({ source }) => {
		const v3 = migratedSource(source)
		const kind = (v3 as { kind: string }).kind

		expect(dataSourceEndpoint(v3)).toBe(kind === "route" ? dataSourceEndpoint(source) : null)
	})
})

describe("the v3 upgrade totality and idempotence", () => {
	it.each(V2_SOURCES)("$label is idempotent", ({ source }) => {
		const once = migratedSource(source)
		expect(migratedSource(once)).toEqual(once)
	})

	it.each([
		{ label: "widgets is not an array", document: { widgets: "nope" } },
		{ label: "widget is not an object", document: { widgets: [42] } },
		{ label: "widget has no dataSource", document: { widgets: [{ id: "w" }] } },
	])("returns $label unchanged rather than throwing", ({ document }) => {
		expect(() => upgradeDocumentToV3(document)).not.toThrow()
	})

	it("carries an unrecognised endpoint through as a route, losing nothing", () => {
		const source = { endpoint: "some_endpoint_this_build_never_heard_of", params: { a: 1 } }
		expect(migratedSource(source)).toEqual({
			kind: "route",
			endpoint: "some_endpoint_this_build_never_heard_of",
			params: { a: 1 },
		})
	})

	it("defaults a missing raw SQL string to empty rather than dropping the widget", () => {
		expect(migratedSource({ endpoint: RAW_SQL_ENDPOINT, params: {} })).toEqual({
			kind: "raw_sql",
			sql: "",
		})
	})
})

describe("the v3 upgrade recurses into display.sparkline.dataSource", () => {
	// `display.sparkline.dataSource` embeds a full data source, and `v1ToV2` never
	// had to recurse — so there is no precedent in this directory that would have
	// caught a missed sparkline.
	it("migrates the sparkline's own data source", () => {
		const document = documentWith(
			{ endpoint: MARKDOWN_STATIC_ENDPOINT },
			{
				title: "T",
				sparkline: {
					enabled: true,
					dataSource: { endpoint: QUERY_SHAPE_ENDPOINTS.timeseries, params: { queries: [query] } },
				},
			},
		)
		const display = firstWidget(document).display as { sparkline: { dataSource: unknown } }

		expect(display.sparkline.dataSource).toEqual({
			kind: "query",
			resultShape: "timeseries",
			queries: [query],
		})
	})

	it("leaves a sparkline with no data source alone", () => {
		const document = documentWith({ endpoint: "list_traces" }, { sparkline: { enabled: false } })
		expect(firstWidget(document).display).toEqual({ sparkline: { enabled: false } })
	})
})

describe("the v3 upgrade output decodes as v3", () => {
	const decode = Schema.decodeUnknownSync(DashboardDocumentV3)

	it.each(V2_SOURCES)("$label produces a decodable document", ({ source }) => {
		expect(() => decode({ ...upgraded(documentWith(source)), schemaVersion: 3 })).not.toThrow()
	})
})

// The backfill's "is this row done?" test. It has to agree with the transform,
// or the script either skips rows it should convert or rewrites rows forever.
describe("isDocumentV3", () => {
	it.each(V2_SOURCES)("is false for a stored $label, true once upgraded", ({ source }) => {
		expect(isDocumentV3(documentWith(source))).toBe(false)
		expect(isDocumentV3(upgradeDocumentToV3(documentWith(source)))).toBe(true)
	})

	it("is false when only the sparkline is left behind", () => {
		const halfDone = documentWith(
			{ kind: "static" },
			{ sparkline: { enabled: true, dataSource: { endpoint: "list_traces" } } },
		)
		expect(isDocumentV3(halfDone)).toBe(false)
		expect(isDocumentV3(upgradeDocumentToV3(halfDone))).toBe(true)
	})

	// A document with nothing to convert counts as done, so the backfill leaves it
	// alone rather than rewriting every empty dashboard on every run.
	it.each([
		{ label: "no widgets array", document: {} },
		{ label: "an empty widget list", document: { widgets: [] } },
		{ label: "a widget with no data source", document: { widgets: [{ id: "w" }] } },
	])("treats $label as done", ({ document }) => {
		expect(isDocumentV3(document)).toBe(true)
	})
})

// Found by the production dry run, not by inspection: 1 live dashboard and 3
// version snapshots stored `queries[].limit` as a number, because v2 kept the
// drafts inside an unvalidated `params` bag. Without the coercion those rows
// quarantine, and a quarantined row is a dashboard nobody can open.
describe("repairs v2-era drafts that were never validated", () => {
	const withLimit = (limit: unknown) => ({
		endpoint: QUERY_SHAPE_ENDPOINTS.breakdown,
		params: { queries: [{ ...query, limit }] },
	})

	it("coerces a numeric limit to the string the schema declares", () => {
		expect(migratedSource(withLimit(50))).toMatchObject({
			queries: [{ ...query, limit: "50" }],
		})
	})

	it("makes the repaired document decode, where it would otherwise quarantine", () => {
		const decode = Schema.decodeUnknownSync(DashboardDocumentV3)
		expect(() =>
			decode({ ...upgraded(documentWith(withLimit(50))), schemaVersion: 3 }),
		).not.toThrow()
	})

	it("leaves a well-formed string limit alone", () => {
		expect(migratedSource(withLimit("25"))).toMatchObject({ queries: [{ ...query, limit: "25" }] })
	})

	// Narrow on purpose: anything else still fails loudly rather than being
	// silently repaired into something that decodes but means nothing.
	it("does not invent a repair for an unrelated malformation", () => {
		expect(migratedSource(withLimit({ nested: true }))).toMatchObject({
			queries: [{ ...query, limit: { nested: true } }],
		})
	})
})
