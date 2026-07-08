import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"

// The mapper is pure; stub the registry so importing the collection module
// doesn't spin up the ManagedRuntime / atom-registry side effects.
vi.mock("@/lib/registry", () => ({ mapleRuntime: {} }))

import { type ScrapeTargetCheckRow, rowToScrapeTargetCheckDocument } from "./scrape-targets"

const base: ScrapeTargetCheckRow = {
	id: 42,
	target_id: "target_1",
	org_id: "org_1",
	sub_target_key: "",
	checked_at: "2026-07-04T00:00:00.000Z",
	error: null,
	duration_ms: 1500,
	samples_scraped: 120,
	samples_post_relabel: 100,
}

describe("rowToScrapeTargetCheckDocument", () => {
	it("maps a successful check and converts ms → seconds", () => {
		const doc = rowToScrapeTargetCheckDocument(base)
		assert.strictEqual(doc.timestamp, "2026-07-04T00:00:00.000Z")
		assert.strictEqual(doc.success, true)
		assert.strictEqual(doc.subTargetKey, null)
		assert.strictEqual(doc.durationSeconds, 1.5)
		assert.strictEqual(doc.samplesScraped, 120)
		assert.strictEqual(doc.samplesPostMetricRelabeling, 100)
		assert.strictEqual(doc.message, null)
	})

	it("maps a failed check: error → message + success false", () => {
		const doc = rowToScrapeTargetCheckDocument({ ...base, error: "connection refused" })
		assert.strictEqual(doc.success, false)
		assert.strictEqual(doc.message, "connection refused")
	})

	it("surfaces a non-empty sub_target_key and preserves null metrics", () => {
		const doc = rowToScrapeTargetCheckDocument({
			...base,
			sub_target_key: "branch:main",
			duration_ms: null,
			samples_scraped: null,
			samples_post_relabel: null,
		})
		assert.strictEqual(doc.subTargetKey, "branch:main")
		assert.strictEqual(doc.durationSeconds, null)
		assert.strictEqual(doc.samplesScraped, null)
		assert.strictEqual(doc.samplesPostMetricRelabeling, null)
	})
})
