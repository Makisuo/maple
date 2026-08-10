import { Array as Arr, MutableHashMap, Result } from "effect"

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

/** The subset of a detector-state row the incident refcount needs. */
export interface DetectorRefcountRow {
	readonly detectorKey: string
	readonly fingerprintHash: string | null
	readonly lastSampleCount: number | null
}

/**
 * Which *other* series still point at a consolidated incident, accounting for
 * this tick's not-yet-flushed detector-state writes.
 *
 * The refcount that decides whether a consolidated incident may resolve reads
 * `anomaly_detector_states` live, but detector-state writes are now buffered
 * until the end of the org pass. Without this overlay the query returns pre-tick
 * truth: two series sharing one incident that both recover in the same tick each
 * still see the other pointing at it, so neither closes the incident. It then
 * lingers with its headline on an already-recovered series until the one-hour
 * no-data sweep closes it with the wrong reason.
 *
 * The overlay runs both ways. A pending write that no longer points at this
 * incident removes that series from the count even though the database still
 * lists it; a pending write that newly points at it (an attach or reopen earlier
 * in this same pass) adds a series the database does not list yet.
 *
 * `persisted` must therefore be unbounded — a `LIMIT 1` could return the single
 * row this overlay is about to remove and hide a live sibling behind it.
 */
export function effectiveOtherStates<
	P extends {
		readonly detectorKey: string
		// Optional because drizzle's insert shape makes nullable columns optional.
		// An absent value means "not pointing at this incident", same as null.
		readonly openIncidentId?: string | null
		readonly fingerprintHash?: string | null
		readonly lastSampleCount?: number | null
	},
>(options: {
	readonly persisted: ReadonlyArray<DetectorRefcountRow>
	readonly pending: Iterable<P>
	readonly currentDetectorKey: string
	readonly incidentId: string
}): Array<DetectorRefcountRow> {
	const { persisted, pending, currentDetectorKey, incidentId } = options

	const byKey = MutableHashMap.fromIterable(
		Arr.filterMap(persisted, (row) =>
			row.detectorKey === currentDetectorKey
				? Result.failVoid
				: Result.succeed([row.detectorKey, row] as const),
		),
	)

	for (const write of pending) {
		if (write.detectorKey === currentDetectorKey) continue
		if (write.openIncidentId === incidentId) {
			MutableHashMap.set(byKey, write.detectorKey, {
				detectorKey: write.detectorKey,
				fingerprintHash: write.fingerprintHash ?? null,
				lastSampleCount: write.lastSampleCount ?? null,
			})
		} else {
			MutableHashMap.remove(byKey, write.detectorKey)
		}
	}

	return Arr.map(Arr.fromIterable(byKey), ([, row]) => row)
}
