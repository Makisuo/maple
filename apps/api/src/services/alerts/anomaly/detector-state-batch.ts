import { Array as Arr, MutableHashMap } from "effect"

/**
 * Rows per multi-row detector-state upsert.
 *
 * Postgres caps a statement at 65535 bound parameters and `anomaly_detector_states`
 * binds 17 columns per row, so the hard ceiling is ~3,800. The observed peak is
 * 628 series for one org, but series count grows with services × signals × error
 * fingerprints, so this is bounded rather than assumed safe.
 */
export const DETECTOR_STATE_UPSERT_CHUNK = 500

/**
 * Chunks flushed concurrently per org.
 *
 * Chunks are disjoint by `detectorKey`, so concurrent upserts never contend for
 * the same row. The bound is about connections, not correctness: `processOrg`
 * already runs at concurrency 4, and every chunk is its own dial against the
 * same Hyperdrive origin pool.
 */
export const DETECTOR_STATE_FLUSH_CONCURRENCY = 4

/**
 * Prepare accumulated detector-state writes for multi-row upserts.
 *
 * Two things the per-row loop got for free and a batched statement does not:
 *
 * 1. **Dedupe by `detectorKey`, last write wins.** Postgres rejects an
 *    `ON CONFLICT DO UPDATE` that would touch the same row twice in one
 *    statement ("cannot affect row a second time"). Last-wins reproduces what
 *    the sequential loop did when a key appeared more than once.
 * 2. **Chunking**, to stay under the bound-parameter cap.
 *
 * Insertion order is preserved — `MutableHashMap.set` on an existing key updates
 * in place rather than reordering — so the emitted statements stay deterministic,
 * which is what makes the round-trip count assertable in tests.
 *
 * Callers pass rows for a single org, so `detectorKey` alone is the right dedupe
 * key even though the table's conflict target is `(orgId, detectorKey)`.
 */
export function batchDetectorStates<T extends { readonly detectorKey: string }>(
	rows: ReadonlyArray<T>,
	chunkSize: number = DETECTOR_STATE_UPSERT_CHUNK,
): Array<Array<T>> {
	if (Arr.isReadonlyArrayEmpty(rows)) return []

	const deduped = Arr.reduce(rows, MutableHashMap.empty<string, T>(), (acc, row) =>
		MutableHashMap.set(acc, row.detectorKey, row),
	)

	return Arr.chunksOf(
		Arr.map(Arr.fromIterable(deduped), ([, row]) => row),
		chunkSize,
	)
}
