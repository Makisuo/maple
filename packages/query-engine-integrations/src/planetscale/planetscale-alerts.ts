/**
 * Raw-SQL bodies for the PlanetScale alert templates.
 *
 * These are deliberately hand-written strings rather than DSL builders: the
 * alert runtime's `$__orgFilter` and `$__timeFilter(col)` macros are substituted
 * at evaluation time and are not expressible in the typed builder. That makes
 * them the one place in the query layer where a typo is invisible until an alert
 * evaluates, which is why `planetscale-alerts.test.ts` asserts the contract
 * (both macros present, a `value` column selected, no denied keyword) rather
 * than trusting review.
 *
 * The alert runtime requires:
 *   - `$__orgFilter` and `$__timeFilter(<column>)` somewhere in the statement
 *   - a `value` column in the result
 *   - optional `group`, `samples`, `bucket` columns
 */

/** The `used %` phrasing validated in planetscale-map.ts, as raw SQL. */
export const PLANETSCALE_STORAGE_USED_SQL = `
SELECT
  concat(db, '/', br) AS \`group\`,
  max(used_pct) AS value,
  sum(n) AS samples
FROM (
  SELECT
    Attributes['planetscale_database_name'] AS db,
    Attributes['planetscale_branch_name'] AS br,
    TimeUnix AS t,
    100 - minIf(Value, MetricName = 'planetscale_volume_available_bytes')
        / nullIf(maxIf(Value, MetricName = 'planetscale_volume_capacity_bytes'), 0) * 100 AS used_pct,
    countIf(MetricName = 'planetscale_volume_available_bytes') AS n
  FROM metrics_gauge
  WHERE $__orgFilter
    AND $__timeFilter(TimeUnix)
    AND MetricName IN ('planetscale_volume_available_bytes', 'planetscale_volume_capacity_bytes')
  GROUP BY db, br, t
  HAVING n > 0
)
GROUP BY db, br
`.trim()

/**
 * Days until a branch's volume fills, from the slope of its free-space series.
 *
 * Two guards that are the difference between a useful forecast and a pager
 * magnet:
 *
 *  - `3650` is the "not shrinking" sentinel. Without it a healthy volume has a
 *    non-negative slope, produces no runway at all, and a `lt` comparator would
 *    read the absence as a breach.
 *  - `HAVING samples >= 60` (≈5h at a 5-minute scrape) stops a freshly-connected
 *    database forecasting a disaster off three datapoints.
 *
 * Known limitation, deliberately accepted at warning severity: a partially
 * gapped free-space series still biases the slope. Do not promote a rule built
 * from this to critical without a gap check.
 */
export const PLANETSCALE_STORAGE_RUNWAY_SQL = `
SELECT
  concat(db, '/', br) AS \`group\`,
  if(slope < 0, avail_last / (-slope) / 86400, 3650) AS value,
  samples
FROM (
  SELECT
    Attributes['planetscale_database_name'] AS db,
    Attributes['planetscale_branch_name'] AS br,
    simpleLinearRegression(toFloat64(toUnixTimestamp(TimeUnix)), Value).1 AS slope,
    argMax(Value, TimeUnix) AS avail_last,
    count() AS samples
  FROM metrics_gauge
  WHERE $__orgFilter
    AND $__timeFilter(TimeUnix)
    AND MetricName = 'planetscale_volume_available_bytes'
  GROUP BY db, br
  HAVING samples >= 60
)
`.trim()
