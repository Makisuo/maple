import { assert, describe, it } from "@effect/vitest"
import { isShapeName, isValidScopeValue, lookupShape, SHAPE_NAMES, shapeScopeColumn } from "./registry"

describe("isShapeName", () => {
	it("accepts whitelisted shapes and rejects everything else", () => {
		assert.isTrue(isShapeName("dashboards"))
		assert.isTrue(isShapeName("alert_rules"))
		assert.isTrue(isShapeName("alert_destinations"))
		assert.isTrue(isShapeName("api_keys"))
		// Pruned from both the whitelist and the publication (0022) once their
		// client collections were removed — they must not resolve as shapes.
		assert.isFalse(isShapeName("error_issues"))
		assert.isFalse(isShapeName("actors"))
		assert.isFalse(isShapeName("open_error_incidents"))
		assert.isFalse(isShapeName("scrape_target_checks"))
		assert.isFalse(isShapeName("users"))
		assert.isFalse(isShapeName("dashboards; drop table"))
		assert.isFalse(isShapeName(null))
		// Must not be fooled by prototype keys.
		assert.isFalse(isShapeName("toString"))
		assert.isFalse(isShapeName("constructor"))
	})
})

describe("lookupShape", () => {
	it("resolves a definition with a table for every whitelisted shape", () => {
		for (const shape of SHAPE_NAMES) {
			assert.isString(lookupShape(shape).table, shape)
		}
	})

	it("keeps the PK in every column projection (Electric requires it)", () => {
		for (const shape of SHAPE_NAMES) {
			const columns = lookupShape(shape).columns
			if (columns === undefined) continue
			assert.include(columns, "id", shape)
			// org_id is the tenant boundary and is filtered on, so it must survive
			// the projection too.
			assert.include(columns, "org_id", shape)
		}
	})
})

describe("scoped shapes", () => {
	it("marks exactly the investigation shapes as scoped", () => {
		assert.strictEqual(shapeScopeColumn("investigation"), "id")
		assert.strictEqual(shapeScopeColumn("investigation_lens_runs"), "investigation_id")
		// Everything else is org-wide; a stray `scope` on one of these is ignored.
		assert.isNull(shapeScopeColumn("dashboards"))
		assert.isNull(shapeScopeColumn("alert_rules"))
	})

	it("rejects an absent or unbounded scope value", () => {
		assert.isFalse(isValidScopeValue(null))
		assert.isFalse(isValidScopeValue(""))
		assert.isFalse(isValidScopeValue("x".repeat(129)))
		assert.isTrue(isValidScopeValue("inv_YofPTrK9782DWwcnXhpcCw"))
	})
})
