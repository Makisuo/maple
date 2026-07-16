import type { TimeseriesPoint } from "../query-engine"

/**
 * Codec that lets the alert-`evaluate` path reuse the timeseries bucket cache
 * (`BucketCacheService`), which stores `TimeseriesPoint { bucket, series:
 * Record<string, number> }`.
 *
 * The bucket cache is built for the dashboard `execute` path, whose points only
 * carry an aggregated value per group. Alert evaluation additionally needs the
 * per-bucket **sample count** (to compute `GroupedAlertObservation.sampleCount`
 * and `hasData`) and must tolerate `null` values (a bucket with no data).
 *
 * `series` is `Record<string, number>` — it can hold neither a second number
 * per group nor `null`. So we encode, per group key `G`:
 *   - `CNT_PREFIX + G` -> sampleCount   (always written, even when 0)
 *   - `VAL_PREFIX + G` -> value         (written ONLY when finite; absence = null)
 *
 * The prefixes are NUL-delimited so they can never collide with a real group
 * key (service names, attribute values, `"all"`, or `" · "`-joined
 * composites never start with a NUL byte). These encoded points are produced
 * AND consumed only by the evaluate path (isolated from execute points by a
 * discriminated cache fingerprint), so the encoding never leaks into dashboard
 * rendering.
 */

const VAL_PREFIX = "\u0000v\u0000"
const CNT_PREFIX = "\u0000n\u0000"

/** One CH row's contribution: a (bucket, group) aggregate plus its sample count. */
export interface BucketGroupObs {
	readonly bucket: string
	readonly groupKey: string
	/** `null` when the bucket has no data for this group (sampleCount === 0). */
	readonly value: number | null
	readonly sampleCount: number
}

/** The shape `reducePerGroupObservations` consumes, per group. */
export interface ReducibleObs {
	readonly value: number | null
	readonly sampleCount: number
	readonly hasData: boolean
}

/**
 * Group per-(bucket, group) observations into `TimeseriesPoint[]`, one point
 * per bucket, preserving first-seen bucket order (CH returns buckets ascending).
 * Non-finite values (e.g. NaN from a metric with no matching column) are
 * normalized to "no value" so the encoding is stable across JSON round-trips —
 * `JSON.stringify(NaN)` is `null`, which would otherwise decode inconsistently.
 */
export const encodeEvalPoints = (obs: ReadonlyArray<BucketGroupObs>): TimeseriesPoint[] => {
	const byBucket = new Map<string, Record<string, number>>()
	const order: string[] = []
	for (const o of obs) {
		let series = byBucket.get(o.bucket)
		if (!series) {
			series = {}
			byBucket.set(o.bucket, series)
			order.push(o.bucket)
		}
		series[CNT_PREFIX + o.groupKey] = o.sampleCount
		if (o.value != null && Number.isFinite(o.value)) {
			series[VAL_PREFIX + o.groupKey] = o.value
		}
	}
	return order.map((bucket) => ({ bucket, series: byBucket.get(bucket)! }))
}

/**
 * Decode cached + freshly-computed points back into per-group observation lists,
 * ready for `reducePerGroupObservations`. Iterates the count entries (one per
 * group present in a bucket); a paired value entry supplies the aggregate, and
 * its absence means `null`. `hasData` is derived purely from the sample count,
 * matching the original evaluate logic.
 */
/**
 * Decode encoded eval points into flat per-(bucket, group) observations,
 * preserving bucket order. Same iteration as {@link decodeEvalPoints} but keeps
 * the bucket on each observation — used by the preview/`evaluateSeries` path,
 * which charts the per-window values instead of reducing them to a scalar.
 */
export const decodeEvalSeries = (points: ReadonlyArray<TimeseriesPoint>): BucketGroupObs[] => {
	const series: BucketGroupObs[] = []
	for (const point of points) {
		for (const [key, num] of Object.entries(point.series)) {
			if (!key.startsWith(CNT_PREFIX)) continue
			const groupKey = key.slice(CNT_PREFIX.length)
			const valKey = VAL_PREFIX + groupKey
			const hasValue = Object.prototype.hasOwnProperty.call(point.series, valKey)
			series.push({
				bucket: point.bucket,
				groupKey,
				value: hasValue ? point.series[valKey]! : null,
				sampleCount: num,
			})
		}
	}
	return series
}

export const decodeEvalPoints = (
	points: ReadonlyArray<TimeseriesPoint>,
): Map<string, Array<ReducibleObs>> => {
	const byGroup = new Map<string, Array<ReducibleObs>>()
	for (const point of points) {
		for (const [key, num] of Object.entries(point.series)) {
			if (!key.startsWith(CNT_PREFIX)) continue
			const groupKey = key.slice(CNT_PREFIX.length)
			const sampleCount = num
			const valKey = VAL_PREFIX + groupKey
			const hasValue = Object.prototype.hasOwnProperty.call(point.series, valKey)
			const obs: ReducibleObs = {
				value: hasValue ? point.series[valKey]! : null,
				sampleCount,
				hasData: sampleCount > 0,
			}
			const list = byGroup.get(groupKey)
			if (list) list.push(obs)
			else byGroup.set(groupKey, [obs])
		}
	}
	return byGroup
}
