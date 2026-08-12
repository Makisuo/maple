import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { parseStoredDashboard, stampCurrentVersion } from "../parse"
import { CURRENT_DASHBOARD_SCHEMA_VERSION } from "../version"
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

const parse = (payload: unknown) => Effect.runSync(parseStoredDashboard(payload))

describe("the migration chain", () => {
	it("is contiguous and terminates at the current version", () => {
		let expected = 1
		for (const migration of DASHBOARD_MIGRATIONS) {
			expect(migration.from).toBe(expected)
			expect(migration.to).toBe(expected + 1)
			expected = migration.to
		}
		expect(expected).toBe(CURRENT_DASHBOARD_SCHEMA_VERSION)
	})

	it("is idempotent at every step", () => {
		for (const migration of DASHBOARD_MIGRATIONS) {
			const once = migration.migrate(legacyDocument)
			expect(migration.migrate(once)).toEqual(once)
		}
	})

	it("migrateToLatest is idempotent", () => {
		const once = migrateToLatest(legacyDocument)
		expect(migrateToLatest(once)).toEqual(once)
	})

	it("never throws on input it cannot understand", () => {
		for (const payload of [null, undefined, 42, "nope", [], { widgets: "not an array" }]) {
			expect(() => migrateToLatest(payload)).not.toThrow()
		}
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

describe("parseStoredDashboard", () => {
	it("decodes a legacy unstamped document and reports the version it came from", () => {
		const outcome = parse(legacyDocument)

		expect(outcome._tag).toBe("Decoded")
		if (outcome._tag !== "Decoded") return
		expect(outcome.fromVersion).toBe(1)
		expect(outcome.degradedWidgetIds).toEqual([])
		expect(outcome.document.name).toBe("Legacy board")
		expect(outcome.document.widgets).toHaveLength(1)
	})

	it("carries widget params through byte-for-byte", () => {
		const outcome = parse(legacyDocument)

		if (outcome._tag !== "Decoded") throw new Error("expected Decoded")
		expect(outcome.document.widgets[0]?.dataSource.params).toEqual(
			legacyDocument.widgets[0]!.dataSource.params,
		)
	})

	it("rejects a structurally corrupt document instead of half-decoding it", () => {
		const outcome = parse({ ...legacyDocument, widgets: [{ id: "broken" }] })

		expect(outcome._tag).toBe("Rejected")
		if (outcome._tag !== "Rejected") return
		expect(outcome.fromVersion).toBe(1)
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
