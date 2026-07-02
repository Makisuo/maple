/**
 * GraphQL documents + response decoders for the Cloudflare Analytics API poller.
 *
 * Kept pure (no Effect services) so the documents can be snapshot-tested and the decoders
 * exercised against fixture payloads. Decoding is deliberately defensive: Cloudflare's GraphQL
 * schema varies by plan (free plans lack the timing-quantile fields entirely), so every metric
 * field is optional/nullable and the mapping layer treats absence as "don't emit that metric".
 */
import { Schema } from "effect"

export const HTTP_DATASET = "http_requests"
export const WORKERS_DATASET = "workers_invocations"
export type CloudflareAnalyticsDataset = typeof HTTP_DATASET | typeof WORKERS_DATASET

/** Cloudflare caps zone-scoped GraphQL queries at 10 zones per call. */
export const MAX_ZONES_PER_QUERY = 10

/** Max rows Cloudflare returns per selection — window sizing must keep group counts below this. */
export const GROUP_LIMIT = 5000

const nullableNumber = Schema.optional(Schema.Union([Schema.Number, Schema.Null]))
const nullableString = Schema.optional(Schema.Union([Schema.String, Schema.Null]))

// ---------------------------------------------------------------------------
// Dataset settings (per-tenant limits discovery)
// ---------------------------------------------------------------------------

/**
 * The `settings` discovery node is the only authoritative source for a tenant's retention
 * (`notOlderThan`), max query range (`maxDuration`), and available fields — all plan-dependent.
 */
export const settingsQuery = (options: { readonly withZones: boolean }): string => {
	const zonesSelection = options.withZones
		? `
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      settings {
        httpRequestsAdaptiveGroups {
          enabled
          notOlderThan
          maxDuration
          availableFields
        }
      }
    }`
		: ""
	return `query MapleCfDatasetSettings($accountTag: string!${options.withZones ? ", $zoneTags: [string!]" : ""}) {
  viewer {${zonesSelection}
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        workersInvocationsAdaptive {
          enabled
          notOlderThan
          maxDuration
          availableFields
        }
      }
    }
  }
}`
}

export const DatasetSettings = Schema.Struct({
	enabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
	notOlderThan: nullableNumber,
	maxDuration: nullableNumber,
	availableFields: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
})
export type DatasetSettingsShape = typeof DatasetSettings.Type

const SettingsResponse = Schema.Struct({
	viewer: Schema.Struct({
		zones: Schema.optional(
			Schema.Union([
				Schema.Array(
					Schema.Struct({
						zoneTag: Schema.String,
						settings: Schema.optional(
							Schema.Union([
								Schema.Struct({
									httpRequestsAdaptiveGroups: Schema.optional(
										Schema.Union([DatasetSettings, Schema.Null]),
									),
								}),
								Schema.Null,
							]),
						),
					}),
				),
				Schema.Null,
			]),
		),
		accounts: Schema.optional(
			Schema.Union([
				Schema.Array(
					Schema.Struct({
						settings: Schema.optional(
							Schema.Union([
								Schema.Struct({
									workersInvocationsAdaptive: Schema.optional(
										Schema.Union([DatasetSettings, Schema.Null]),
									),
								}),
								Schema.Null,
							]),
						),
					}),
				),
				Schema.Null,
			]),
		),
	}),
})

export const decodeSettingsResponse = Schema.decodeUnknownEffect(SettingsResponse)
export type SettingsResponseShape = typeof SettingsResponse.Type

// ---------------------------------------------------------------------------
// HTTP edge analytics (zone-scoped httpRequestsAdaptiveGroups)
// ---------------------------------------------------------------------------

const HTTP_QUANTILES_SELECTION = `
        quantiles {
          edgeTimeToFirstByteMsP50
          edgeTimeToFirstByteMsP95
          edgeTimeToFirstByteMsP99
          originResponseDurationMsP50
          originResponseDurationMsP95
          originResponseDurationMsP99
        }`

/**
 * Two selections per zone over the same window:
 * - `groups`: counters dimensioned by (5-min bucket, cacheStatus, edgeResponseStatus).
 * - `latency`: zone-level TTFB/origin-duration quantiles per 5-min bucket, dimension-light on
 *   purpose — per-(cacheStatus,status) quantiles cannot be honestly re-aggregated across groups,
 *   so we ask Cloudflare for the zone-level percentiles directly. Omitted entirely when the
 *   plan's `availableFields` lacks the quantile fields.
 *
 * `requestSource: "eyeball"` excludes Worker subrequests (Cloudflare's own migration-guide
 * recommendation) so edge counts match what the dashboard's HTTP-traffic view means.
 */
export const httpAnalyticsQuery = (options: { readonly withQuantiles: boolean }): string =>
	`query MapleCfHttpAnalytics($zoneTags: [string!], $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      groups: httpRequestsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }
      ) {
        count
        avg { sampleInterval }
        sum { edgeResponseBytes visits }
        dimensions { datetimeFiveMinutes cacheStatus edgeResponseStatus }
      }
      latency: httpRequestsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }
      ) {
        count${options.withQuantiles ? HTTP_QUANTILES_SELECTION : ""}
        dimensions { datetimeFiveMinutes }
      }
    }
  }
}`

const HttpGroup = Schema.Struct({
	count: Schema.Number,
	avg: Schema.optional(
		Schema.Union([Schema.Struct({ sampleInterval: nullableNumber }), Schema.Null]),
	),
	sum: Schema.optional(
		Schema.Union([
			Schema.Struct({ edgeResponseBytes: nullableNumber, visits: nullableNumber }),
			Schema.Null,
		]),
	),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		cacheStatus: nullableString,
		edgeResponseStatus: nullableNumber,
	}),
})
export type HttpGroupShape = typeof HttpGroup.Type

const HttpQuantiles = Schema.Struct({
	edgeTimeToFirstByteMsP50: nullableNumber,
	edgeTimeToFirstByteMsP95: nullableNumber,
	edgeTimeToFirstByteMsP99: nullableNumber,
	originResponseDurationMsP50: nullableNumber,
	originResponseDurationMsP95: nullableNumber,
	originResponseDurationMsP99: nullableNumber,
})
export type HttpQuantilesShape = typeof HttpQuantiles.Type

const HttpLatencyGroup = Schema.Struct({
	count: Schema.Number,
	quantiles: Schema.optional(Schema.Union([HttpQuantiles, Schema.Null])),
	dimensions: Schema.Struct({ datetimeFiveMinutes: Schema.String }),
})
export type HttpLatencyGroupShape = typeof HttpLatencyGroup.Type

const HttpZoneResult = Schema.Struct({
	zoneTag: Schema.String,
	groups: Schema.Array(HttpGroup),
	latency: Schema.Array(HttpLatencyGroup),
})
export type HttpZoneResultShape = typeof HttpZoneResult.Type

const HttpAnalyticsResponse = Schema.Struct({
	viewer: Schema.Struct({
		zones: Schema.optional(Schema.Union([Schema.Array(HttpZoneResult), Schema.Null])),
	}),
})

export const decodeHttpAnalyticsResponse = Schema.decodeUnknownEffect(HttpAnalyticsResponse)

// ---------------------------------------------------------------------------
// Workers invocations (account-scoped workersInvocationsAdaptive)
// ---------------------------------------------------------------------------

const WORKERS_QUANTILES_SELECTION = `
        quantiles {
          cpuTimeP50
          cpuTimeP99
          durationP50
          durationP99
        }`

export const workersAnalyticsQuery = (options: { readonly withQuantiles: boolean }): string =>
	`query MapleCfWorkersAnalytics($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      invocations: workersInvocationsAdaptive(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        sum { requests errors subrequests }${options.withQuantiles ? WORKERS_QUANTILES_SELECTION : ""}
        dimensions { datetimeFiveMinutes scriptName status }
      }
    }
  }
}`

const WorkersQuantiles = Schema.Struct({
	cpuTimeP50: nullableNumber,
	cpuTimeP99: nullableNumber,
	durationP50: nullableNumber,
	durationP99: nullableNumber,
})
export type WorkersQuantilesShape = typeof WorkersQuantiles.Type

const WorkersGroup = Schema.Struct({
	sum: Schema.optional(
		Schema.Union([
			Schema.Struct({
				requests: nullableNumber,
				errors: nullableNumber,
				subrequests: nullableNumber,
			}),
			Schema.Null,
		]),
	),
	quantiles: Schema.optional(Schema.Union([WorkersQuantiles, Schema.Null])),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		scriptName: Schema.String,
		status: nullableString,
	}),
})
export type WorkersGroupShape = typeof WorkersGroup.Type

const WorkersAnalyticsResponse = Schema.Struct({
	viewer: Schema.Struct({
		accounts: Schema.optional(
			Schema.Union([
				Schema.Array(Schema.Struct({ invocations: Schema.Array(WorkersGroup) })),
				Schema.Null,
			]),
		),
	}),
})

export const decodeWorkersAnalyticsResponse = Schema.decodeUnknownEffect(WorkersAnalyticsResponse)

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/** Cloudflare's `Time` scalar accepts RFC 3339; second precision keeps documents stable. */
export const toGraphqlTime = (epochMs: number): string =>
	new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace(".000Z", "Z")
