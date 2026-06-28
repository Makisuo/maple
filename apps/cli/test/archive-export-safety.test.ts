import { describe, it } from "@effect/vitest"
import { throws } from "node:assert"
import { exportSignalShards } from "../src/server/archives/export"

// Pure-logic tests for export safety primitives that don't require chDB.
// The full Parquet write+reopen+validation path is exercised by the native
// archive smoke (Gate 5). These tests pin the safety invariants: path
// rejection and SQL escaping.

describe("export path safety (M-1)", () => {
	it("rejects a shardsDir containing a single quote", () => {
		throws(
			// A null db is never reached: assertSafePath runs before any query.
			() =>
				exportSignalShards(
					null as never,
					{ name: "traces", eventTimeColumn: "Timestamp" } as never,
					"2026-06-01",
					"/tmp/o'clock",
					{ writerThreads: 1, rowGroupRows: 100, maxShardRows: 10, maxShardBytes: 1024 } as never,
				),
			/single quote/,
		)
	})

	it("rejects a shardsDir containing a backslash", () => {
		throws(
			() =>
				exportSignalShards(
					null as never,
					{ name: "traces", eventTimeColumn: "Timestamp" } as never,
					"2026-06-01",
					"/tmp/back\\slash",
					{ writerThreads: 1, rowGroupRows: 100, maxShardRows: 10, maxShardBytes: 1024 } as never,
				),
			/backslash/,
		)
	})
})
