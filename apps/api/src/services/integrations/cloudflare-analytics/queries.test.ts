import { assert, describe, it } from "@effect/vitest"
import { MAX_QUERIES_PER_REQUEST, MAX_ZONES_PER_QUERY, zoneChunkSizeFor } from "./queries"

describe("zoneChunkSizeFor", () => {
	// Regression: the planner batches every zone dataset into one `zones` selection, and
	// Cloudflare rejects on `zones × nodes` rather than on zones alone. Chunking by
	// MAX_ZONES_PER_QUERY regardless of dataset count sent 5-dataset documents at 10 zones
	// (50 queries) and drew "In combination, your request queries too many nodes, zones and
	// accounts" on every tick — permanently, since the frontier only advances on success.
	it("keeps zones × nodes within Cloudflare's per-request budget", () => {
		for (let nodeCount = 1; nodeCount <= MAX_QUERIES_PER_REQUEST; nodeCount++) {
			assert.isAtMost(zoneChunkSizeFor(nodeCount) * nodeCount, MAX_QUERIES_PER_REQUEST)
		}
	})

	it("matches the zone cap when the document holds a single node", () => {
		assert.strictEqual(zoneChunkSizeFor(1), MAX_ZONES_PER_QUERY)
	})

	it("shrinks the chunk as datasets batch together", () => {
		assert.strictEqual(zoneChunkSizeFor(2), 5)
		assert.strictEqual(zoneChunkSizeFor(5), 2)
	})

	// A chunk of 0 would drop the zone from the plan entirely — silent data loss, and worse
	// than an oversized request. More nodes than the budget still yields one zone per document.
	it("never yields an empty chunk, even past the budget", () => {
		assert.strictEqual(zoneChunkSizeFor(MAX_QUERIES_PER_REQUEST + 5), 1)
		assert.strictEqual(zoneChunkSizeFor(0), MAX_ZONES_PER_QUERY)
	})
})
