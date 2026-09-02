import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { parseStoredDashboard, stampCurrentVersion } from "../parse"
import { CURRENT_DASHBOARD_SCHEMA_VERSION } from "../version"
import { upgradeStoredDocument } from "../upgrade-to-v3"
import { DASHBOARD_MIGRATIONS, detectSchemaVersion, migrateToLatest } from "./index"

/** A minimal but complete v1 document, as a pre-versioning row would be stored. */
const legacyDocument = {
	id: "3f1b7c62-5a1e-4d0f-9a3b-6c2e8d4f1a90",
	name: "Legacy board",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "widget-1",
			visualization: "chart",
			dataSource: {
				endpoint: "custom_query_builder_timeseries",
				params: { queries: [{ id: "a", name: "A", dataSource: "traces", aggregation: "count" }] },
			},
			display: { title: "Requests" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

/**
 * A v1 document carrying a value in each of the three fields v2 closes that is
 * outside the closed set — the shape the migration exists to rescue.
 */
const looseDocument = {
	...legacyDocument,
	widgets: [
		{
			...legacyDocument.widgets[0],
			visualization: "sankey",
			dataSource: {
				endpoint: "custom_query_builder_timeseries",
				params: { queries: [{ id: "a", name: "A", dataSource: "traces", aggregation: "count" }] },
				transform: {
					reduceToValue: { field: "value", aggregate: "median" },
					sortBy: { field: "value", direction: "descending" },
				},
			},
		},
	],
}

/**
 * Reads a stored payload the way the BACKFILL does — chain, then the one-shot
 * v2 -> v3 upgrade — and then decodes.
 *
 * `parseStoredDashboard` alone no longer suffices for a legacy fixture: the
 * decoder is v3 while `migrateToLatest` only reaches v2, because the v2 -> v3
 * step is a one-shot backfill rather than a chain entry. That gap IS the
 * migration window, and asserting through `upgradeStoredDocument` is what makes
 * these tests cover the path that actually closes it.
 */
const parse = (payload: unknown) => Effect.runSync(parseStoredDashboard(upgradeStoredDocument(payload)))

const firstWidget = (document: Record<string, unknown>): Record<string, unknown> => {
	const widgets = document.widgets
	if (!Array.isArray(widgets)) throw new Error("expected widgets to be an array")
	const [widget] = widgets
	if (typeof widget !== "object" || widget === null) throw new Error("expected a widget object")
	return widget
}

describe("the migration chain", () => {
	// The chain no longer runs all the way to the current version, and that is the
	// design rather than a gap: the v2 -> v3 step is a one-shot backfill
	// (`upgrade-to-v3.ts`), not a chain entry, so the chain stops at 2 while
	// current is 3. What must still hold is contiguity from 1 — a hole in the
	// chain silently skips a document.
	it("is contiguous from 1", () => {
		let expected = 1
		for (const migration of DASHBOARD_MIGRATIONS) {
			expect(migration.from).toBe(expected)
			expect(migration.to).toBe(expected + 1)
			expected = migration.to
		}
		expect(expected).toBeLessThanOrEqual(CURRENT_DASHBOARD_SCHEMA_VERSION)
	})

	// Run idempotence over the *loose* document too: a step that coerces is only
	// idempotent if its output is already a member of the set it coerces into,
	// and a clean fixture cannot tell the difference.
	it("is idempotent at every step", () => {
		for (const migration of DASHBOARD_MIGRATIONS) {
			for (const fixture of [legacyDocument, looseDocument]) {
				const once = migration.migrate(fixture)
				expect(migration.migrate(once)).toEqual(once)
			}
		}
	})

	it("migrateToLatest is idempotent", () => {
		for (const fixture of [legacyDocument, looseDocument]) {
			const once = migrateToLatest(fixture)
			expect(migrateToLatest(once)).toEqual(once)
		}
	})

	it("never throws on input it cannot understand", () => {
		for (const payload of [null, undefined, 42, "nope", [], { widgets: "not an array" }]) {
			expect(() => migrateToLatest(payload)).not.toThrow()
		}
	})
})

describe("the v1 -> v2 step", () => {
	it("coerces each closed field to the value the old build already behaved as", () => {
		const widget = firstWidget(migrateToLatest(looseDocument))

		expect(widget.visualization).toBe("chart")

		const dataSource = widget.dataSource
		expect(dataSource).toMatchObject({
			transform: {
				reduceToValue: { field: "value", aggregate: "first" },
				// `applyTransform` tests `=== "desc"`, so "descending" already sorted
				// ascending — coercing to "asc" is what preserves the rendering.
				sortBy: { field: "value", direction: "asc" },
			},
		})
	})

	it("leaves values that are already in the closed set alone", () => {
		const widget = firstWidget(
			migrateToLatest({
				...legacyDocument,
				widgets: [
					{
						...legacyDocument.widgets[0],
						visualization: "heatmap",
						dataSource: {
							endpoint: "custom_query_builder_breakdown",
							transform: {
								reduceToValue: { field: "value", aggregate: "max" },
								sortBy: { field: "value", direction: "desc" },
							},
						},
					},
				],
			}),
		)

		expect(widget.visualization).toBe("heatmap")
		expect(widget.dataSource).toMatchObject({
			transform: {
				reduceToValue: { aggregate: "max" },
				sortBy: { direction: "desc" },
			},
		})
	})

	it("carries params byte-for-byte rather than rewriting them", () => {
		const widget = firstWidget(migrateToLatest(looseDocument))
		const dataSource = widget.dataSource
		if (typeof dataSource !== "object" || dataSource === null) throw new Error("expected a dataSource")

		expect(dataSource).toHaveProperty("params", looseDocument.widgets[0]!.dataSource.params)
	})

	// The whole reason the step coerces instead of rejecting: a rejected document
	// is refused by the writable path, so one unrecognised widget would lock the
	// entire dashboard out of editing.
	it("makes a document with out-of-set values decode rather than reject", () => {
		const outcome = parse(looseDocument)

		expect(outcome._tag).toBe("Decoded")
		if (outcome._tag !== "Decoded") return
		// The stored version is read off the raw payload: `parse` here upgrades
		// before decoding, so the outcome reports the version it decoded, not the
		// one the row was written in.
		expect(detectSchemaVersion(looseDocument)).toBe(1)
		expect(outcome.document.widgets[0]?.visualization).toBe("chart")
	})

	// The case that makes this migration more than a rename: `line`/`bar`/`area`
	// are panel types v1 allowed to be stored in `visualization`, and folding
	// them to "chart" without recording which one would turn every stored bar and
	// area widget into a line chart.
	it.each([
		["line", "query-builder-line"],
		["bar", "query-builder-bar"],
		["area", "query-builder-area"],
	])("folds the %s panel type into chart and preserves it as a chartId", (panel, chartId) => {
		const widget = firstWidget(
			migrateToLatest({
				...legacyDocument,
				widgets: [{ ...legacyDocument.widgets[0], visualization: panel, display: { title: "T" } }],
			}),
		)

		expect(widget.visualization).toBe("chart")
		expect(widget.display).toEqual({ title: "T", chartId })
	})

	it("never overwrites a chartId the widget already has", () => {
		const widget = firstWidget(
			migrateToLatest({
				...legacyDocument,
				widgets: [
					{
						...legacyDocument.widgets[0],
						visualization: "area",
						display: { chartId: "gradient-area" },
					},
				],
			}),
		)

		expect(widget.display).toEqual({ chartId: "gradient-area" })
	})

	it("leaves a document whose widgets are not an array for decode to reject", () => {
		const broken = { ...legacyDocument, widgets: "not an array" }
		expect(migrateToLatest(broken).widgets).toBe("not an array")
		expect(parse(broken)._tag).toBe("Rejected")
	})
})

describe("detectSchemaVersion", () => {
	it("reads an absent schemaVersion as version 1", () => {
		expect(detectSchemaVersion(legacyDocument)).toBe(1)
		expect(detectSchemaVersion({})).toBe(1)
	})

	it("reads a declared version", () => {
		expect(detectSchemaVersion({ ...legacyDocument, schemaVersion: 1 })).toBe(1)
	})

	it("falls back to 1 for a non-object, or a version this build does not know", () => {
		expect(detectSchemaVersion(null)).toBe(1)
		expect(detectSchemaVersion([])).toBe(1)
		expect(detectSchemaVersion({ schemaVersion: "2" })).toBe(1)
		expect(detectSchemaVersion({ schemaVersion: 99 })).toBe(1)
	})
})

describe("migrateToLatest with a document from a newer build", () => {
	// The rollback case. `detectSchemaVersion` reads an unknown version as 1, so
	// without a guard the document is run through the entire chain as though it
	// were the oldest shape and then stamped as current — decode fails either
	// way, but stamped, the next writer persists the lie and the original
	// version is gone. Failing to read is recoverable; corrupting is not.
	const fromTheFuture = { ...legacyDocument, schemaVersion: 99, widgets: [] }

	it("returns it untouched rather than restamping it downward", () => {
		expect(migrateToLatest(fromTheFuture)).toEqual(fromTheFuture)
	})

	it("does not claim the current version on the way out", () => {
		expect(migrateToLatest(fromTheFuture).schemaVersion).toBe(99)
	})

	// `migrateToLatest` stamps the version it actually REACHED, which is where the
	// chain ends (2) — not the current version (3). Only `upgradeStoredDocument`,
	// which applies the one-shot v2 -> v3 on top, can honestly stamp 3.
	it("stamps the version the chain actually reached", () => {
		const chainEnd = DASHBOARD_MIGRATIONS[DASHBOARD_MIGRATIONS.length - 1]?.to ?? 1
		expect(migrateToLatest(legacyDocument).schemaVersion).toBe(chainEnd)
	})

	it("only claims the current version once the v3 upgrade has run too", () => {
		const upgraded = upgradeStoredDocument(legacyDocument) as Record<string, unknown>
		expect(upgraded.schemaVersion).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
	})
})

describe("parseStoredDashboard", () => {
	it("decodes a legacy unstamped document once it has been upgraded", () => {
		const outcome = parse(legacyDocument)

		// The version the row was STORED in is read off the raw payload — `parse`
		// here upgrades first, so the outcome reports the version it decoded.
		expect(detectSchemaVersion(legacyDocument)).toBe(1)
		expect(outcome._tag).toBe("Decoded")
		if (outcome._tag !== "Decoded") return
		expect(outcome.fromVersion).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
		expect(outcome.degradedWidgetIds).toEqual([])
		expect(outcome.document.name).toBe("Legacy board")
		expect(outcome.document.widgets).toHaveLength(1)
	})

	// v1 -> v2 carried `params` byte-for-byte; the v3 upgrade rewrites the bag into
	// typed fields, so the assertion becomes "the queries survived the reshaping".
	it("carries the widget's queries through the reshaping", () => {
		const outcome = parse(legacyDocument)

		if (outcome._tag !== "Decoded") throw new Error("expected Decoded")
		const dataSource = outcome.document.widgets[0]?.dataSource
		if (dataSource?.kind !== "query") throw new Error("expected a query data source")
		expect(dataSource.queries).toEqual(legacyDocument.widgets[0]!.dataSource.params.queries)
	})

	it("rejects a structurally corrupt document instead of half-decoding it", () => {
		const outcome = parse({ ...legacyDocument, widgets: [{ id: "broken" }] })

		expect(outcome._tag).toBe("Rejected")
		if (outcome._tag !== "Rejected") return
		// The issue names the offending path so a 503 is diagnosable from logs.
		expect(outcome.issue).not.toBe("")
	})

	it("rejects a non-object payload", () => {
		expect(parse(null)._tag).toBe("Rejected")
		expect(parse("nope")._tag).toBe("Rejected")
	})
})

describe("stampCurrentVersion", () => {
	it("stamps the current version", () => {
		expect(stampCurrentVersion({ name: "x" }).schemaVersion).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
	})

	it("produces a document that decodes and round-trips its stamp", () => {
		const stamped = stampCurrentVersion(legacyDocument)
		const outcome = parse(stamped)

		expect(outcome._tag).toBe("Decoded")
		if (outcome._tag !== "Decoded") return
		expect(outcome.fromVersion).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
		expect(outcome.document.schemaVersion).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
	})

	it("keeps the stamp when the document is encoded back to storage JSON", () => {
		const outcome = parse(stampCurrentVersion(legacyDocument))
		if (outcome._tag !== "Decoded") throw new Error("expected Decoded")

		const encoded = Schema.encodeUnknownSync(Schema.Unknown)(outcome.document) as Record<string, unknown>
		expect(encoded.schemaVersion).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
	})
})

describe("the v1 -> v2 step recurses into display.sparkline.dataSource", () => {
	// The sparkline embeds a FULL v1 data source, open transform included. Left
	// unclosed, one legacy value there kept the whole document undecodable under
	// v2/v3 — and the writable path then refused the entire dashboard.
	const sparklineDocument = {
		...legacyDocument,
		widgets: [
			{
				...legacyDocument.widgets[0],
				display: {
					title: "Requests",
					sparkline: {
						enabled: true,
						dataSource: {
							endpoint: "custom_query_builder_timeseries",
							params: {
								queries: [{ id: "a", name: "A", dataSource: "traces", aggregation: "count" }],
							},
							transform: {
								reduceToValue: { field: "value", aggregate: "median" },
								sortBy: { field: "value", direction: "descending" },
							},
						},
					},
				},
			},
		],
	}

	it("closes the sparkline's open transform values", () => {
		const display = firstWidget(migrateToLatest(sparklineDocument)).display
		expect(display).toMatchObject({
			sparkline: {
				dataSource: {
					transform: {
						reduceToValue: { field: "value", aggregate: "first" },
						sortBy: { field: "value", direction: "asc" },
					},
				},
			},
		})
	})

	it("is idempotent on the sparkline too", () => {
		for (const migration of DASHBOARD_MIGRATIONS) {
			const once = migration.migrate(sparklineDocument)
			expect(migration.migrate(once)).toEqual(once)
		}
	})

	it("makes the full document decode through the stored upgrade", () => {
		expect(parse(sparklineDocument)._tag).toBe("Decoded")
	})
})

describe("upgradeStoredDocument with a document from a newer build", () => {
	// `migrateToLatest` refuses to migrate a future document, but the combined
	// upgrader used to run the v3 rewrite on it anyway and restamp it 3 —
	// erasing the version marker and re-encoding shapes it cannot know.
	const fromTheFuture = {
		...legacyDocument,
		schemaVersion: 99,
		widgets: [
			{
				...legacyDocument.widgets[0],
				// A hypothetical future data source with no string `kind`: the v3
				// rewrite would have destructively re-read it as a legacy source.
				dataSource: { kind: 7, spec: { future: true } },
			},
		],
	}

	it("returns it untouched instead of downstamping and rewriting it", () => {
		expect(upgradeStoredDocument(fromTheFuture)).toEqual(fromTheFuture)
	})
})
