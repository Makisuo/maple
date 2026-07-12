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
export const FIREWALL_DATASET = "firewall_events"
export const DNS_DATASET = "dns_queries"
export const QUEUE_BACKLOG_DATASET = "queue_backlog"
export const QUEUE_CONSUMERS_DATASET = "queue_consumers"
export const DO_DATASET = "do_invocations"

/** Cloudflare caps zone-scoped GraphQL queries at 10 zones per call. */
export const MAX_ZONES_PER_QUERY = 10

/** Max rows Cloudflare returns per selection — window sizing must keep group counts below this. */
const GROUP_LIMIT = 5000

/** Cloudflare GraphQL fields are plan-dependent — treat every one as absent-or-null-able. */
const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.Union([schema, Schema.Null]))

const nullableNumber = nullable(Schema.Number)
const nullableString = nullable(Schema.String)

// ---------------------------------------------------------------------------
// Dataset settings (per-tenant limits discovery)
// ---------------------------------------------------------------------------

/**
 * The `settings` discovery node is the only authoritative source for a tenant's retention
 * (`notOlderThan`), max query range (`maxDuration`), and available fields — all plan-dependent.
 */
export const settingsQuery = (options: { readonly withZones: boolean }): string => {
	const fields = `{
          enabled
          notOlderThan
          maxDuration
          availableFields
        }`
	const zonesSelection = options.withZones
		? `
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      settings {
        httpRequestsAdaptiveGroups ${fields}
        firewallEventsAdaptiveGroups ${fields}
        dnsAnalyticsAdaptiveGroups ${fields}
      }
    }`
		: ""
	return `query MapleCfDatasetSettings($accountTag: string!${options.withZones ? ", $zoneTags: [string!]" : ""}) {
  viewer {${zonesSelection}
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        workersInvocationsAdaptive ${fields}
        queueBacklogAdaptiveGroups ${fields}
        queueConsumerMetricsAdaptiveGroups ${fields}
        durableObjectsInvocationsAdaptiveGroups ${fields}
      }
    }
  }
}`
}

export const DatasetSettings = Schema.Struct({
	enabled: nullable(Schema.Boolean),
	notOlderThan: nullableNumber,
	maxDuration: nullableNumber,
	availableFields: nullable(Schema.Array(Schema.String)),
})
export type DatasetSettingsShape = typeof DatasetSettings.Type

const SettingsResponse = Schema.Struct({
	viewer: Schema.Struct({
		zones: nullable(
			Schema.Array(
				Schema.Struct({
					zoneTag: Schema.String,
					settings: nullable(
						Schema.Struct({
							httpRequestsAdaptiveGroups: nullable(DatasetSettings),
							firewallEventsAdaptiveGroups: nullable(DatasetSettings),
							dnsAnalyticsAdaptiveGroups: nullable(DatasetSettings),
						}),
					),
				}),
			),
		),
		accounts: nullable(
			Schema.Array(
				Schema.Struct({
					settings: nullable(
						Schema.Struct({
							workersInvocationsAdaptive: nullable(DatasetSettings),
							queueBacklogAdaptiveGroups: nullable(DatasetSettings),
							queueConsumerMetricsAdaptiveGroups: nullable(DatasetSettings),
							durableObjectsInvocationsAdaptiveGroups: nullable(DatasetSettings),
						}),
					),
				}),
			),
		),
	}),
})
export type SettingsResponseShape = typeof SettingsResponse.Type

export const decodeSettingsResponse = Schema.decodeUnknownEffect(SettingsResponse)

// ---------------------------------------------------------------------------
// Shared analytics documents
// ---------------------------------------------------------------------------
//
// One GraphQL document per (scope, window, zone-chunk): every dataset sharing that window
// contributes aliased selections under the same `zones`/`accounts` node, so adding a dataset
// does not add a GraphQL call in steady state (GROUP_LIMIT is per selection). Each dataset's
// node schema decodes only its own aliases out of the shared node (Schema.Struct ignores the
// sibling aliases), and GraphQL error `path`s attribute per-selection failures back to a dataset.

export const zoneAnalyticsDocument = (selections: ReadonlyArray<string>): string =>
	`query MapleCfZoneAnalytics($zoneTags: [string!], $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
${selections.join("\n")}
    }
  }
}`

export const accountAnalyticsDocument = (selections: ReadonlyArray<string>): string =>
	`query MapleCfAccountAnalytics($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
${selections.join("\n")}
    }
  }
}`

/** Loose envelopes: the zone/account nodes stay `unknown` so each dataset decodes its own aliases. */
const ZoneAnalyticsEnvelope = Schema.Struct({
	viewer: Schema.Struct({ zones: nullable(Schema.Array(Schema.Unknown)) }),
})
export const decodeZoneAnalyticsEnvelope = Schema.decodeUnknownEffect(ZoneAnalyticsEnvelope)

const AccountAnalyticsEnvelope = Schema.Struct({
	viewer: Schema.Struct({ accounts: nullable(Schema.Array(Schema.Unknown)) }),
})
export const decodeAccountAnalyticsEnvelope = Schema.decodeUnknownEffect(AccountAnalyticsEnvelope)

const ZoneTagNode = Schema.Struct({ zoneTag: Schema.String })
export const decodeZoneTagOption = Schema.decodeUnknownOption(ZoneTagNode)

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
 * - `groups`: counters dimensioned by (5-min bucket, cacheStatus, edgeResponseStatus, host).
 *   `orderBy count_DESC` means a GROUP_LIMIT truncation on a many-hostname zone drops the noise
 *   floor rather than arbitrary groups; the mapping layer additionally folds hosts past the top
 *   `MAX_HTTP_HOSTS` into "other" so stored attribute cardinality stays bounded regardless.
 * - `latency`: zone-level TTFB/origin-duration quantiles per 5-min bucket, dimension-light on
 *   purpose — per-(cacheStatus,status) quantiles cannot be honestly re-aggregated across groups,
 *   so we ask Cloudflare for the zone-level percentiles directly. Omitted entirely when the
 *   plan's `availableFields` lacks the quantile fields.
 *
 * `requestSource: "eyeball"` excludes Worker subrequests (Cloudflare's own migration-guide
 * recommendation) so edge counts match what the dashboard's HTTP-traffic view means.
 */
export const httpSelection = (options: { readonly withQuantiles: boolean }): string =>
	`      groups: httpRequestsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }
        orderBy: [count_DESC]
      ) {
        count
        avg { sampleInterval }
        sum { edgeResponseBytes visits }
        dimensions { datetimeFiveMinutes cacheStatus edgeResponseStatus clientRequestHTTPHost }
      }
      latency: httpRequestsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }
      ) {
        count${options.withQuantiles ? HTTP_QUANTILES_SELECTION : ""}
        dimensions { datetimeFiveMinutes }
      }`

const HttpGroup = Schema.Struct({
	count: Schema.Number,
	avg: nullable(Schema.Struct({ sampleInterval: nullableNumber })),
	sum: nullable(Schema.Struct({ edgeResponseBytes: nullableNumber, visits: nullableNumber })),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		cacheStatus: nullableString,
		edgeResponseStatus: nullableNumber,
		clientRequestHTTPHost: nullableString,
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

const HttpLatencyGroup = Schema.Struct({
	count: Schema.Number,
	quantiles: nullable(HttpQuantiles),
	dimensions: Schema.Struct({ datetimeFiveMinutes: Schema.String }),
})
export type HttpLatencyGroupShape = typeof HttpLatencyGroup.Type

const HttpZoneNode = Schema.Struct({
	groups: nullable(Schema.Array(HttpGroup)),
	latency: nullable(Schema.Array(HttpLatencyGroup)),
})

export const decodeHttpZoneNode = Schema.decodeUnknownEffect(HttpZoneNode)

// ---------------------------------------------------------------------------
// Firewall/WAF events (zone-scoped firewallEventsAdaptiveGroups)
// ---------------------------------------------------------------------------

/**
 * Security events by action × source × rule × host. Attack traffic can push the group count past
 * GROUP_LIMIT — `orderBy count_DESC` keeps the truncation to the noise floor, and the mapping
 * layer folds rule ids / hosts past their top-N caps into "other". No quantile fields exist on
 * this dataset, so the selection ignores the quantile flag.
 */
export const firewallSelection = (_options: { readonly withQuantiles: boolean }): string =>
	`      firewall: firewallEventsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [count_DESC]
      ) {
        count
        avg { sampleInterval }
        dimensions { datetimeFiveMinutes action source ruleId clientRequestHTTPHost }
      }`

const FirewallGroup = Schema.Struct({
	count: Schema.Number,
	avg: nullable(Schema.Struct({ sampleInterval: nullableNumber })),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		action: nullableString,
		source: nullableString,
		ruleId: nullableString,
		clientRequestHTTPHost: nullableString,
	}),
})
export type FirewallGroupShape = typeof FirewallGroup.Type

const FirewallZoneNode = Schema.Struct({ firewall: nullable(Schema.Array(FirewallGroup)) })
export const decodeFirewallZoneNode = Schema.decodeUnknownEffect(FirewallZoneNode)

// ---------------------------------------------------------------------------
// DNS analytics (zone-scoped dnsAnalyticsAdaptiveGroups — Cloudflare-DNS zones only)
// ---------------------------------------------------------------------------

export const dnsSelection = (_options: { readonly withQuantiles: boolean }): string =>
	`      dns: dnsAnalyticsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
        orderBy: [count_DESC]
      ) {
        count
        avg { sampleInterval }
        dimensions { datetimeFiveMinutes queryName responseCode }
      }`

const DnsGroup = Schema.Struct({
	count: Schema.Number,
	avg: nullable(Schema.Struct({ sampleInterval: nullableNumber })),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		queryName: nullableString,
		responseCode: nullableString,
	}),
})
export type DnsGroupShape = typeof DnsGroup.Type

const DnsZoneNode = Schema.Struct({ dns: nullable(Schema.Array(DnsGroup)) })
export const decodeDnsZoneNode = Schema.decodeUnknownEffect(DnsZoneNode)

// ---------------------------------------------------------------------------
// Queues (account-scoped queueBacklogAdaptiveGroups / queueConsumerMetricsAdaptiveGroups)
// ---------------------------------------------------------------------------

/** Backlog depth is a point-in-time sample, so `avg` (not `sum`) → mapped to gauges. */
export const queueBacklogSelection = (_options: { readonly withQuantiles: boolean }): string =>
	`      queueBacklog: queueBacklogAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        avg { messages bytes sampleInterval }
        dimensions { datetimeFiveMinutes queueId }
      }`

const QueueBacklogGroup = Schema.Struct({
	avg: nullable(
		Schema.Struct({
			messages: nullableNumber,
			bytes: nullableNumber,
			sampleInterval: nullableNumber,
		}),
	),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		queueId: Schema.String,
	}),
})
export type QueueBacklogGroupShape = typeof QueueBacklogGroup.Type

const QueueBacklogAccountNode = Schema.Struct({ queueBacklog: nullable(Schema.Array(QueueBacklogGroup)) })
export const decodeQueueBacklogAccountNode = Schema.decodeUnknownEffect(QueueBacklogAccountNode)

export const queueConsumersSelection = (_options: { readonly withQuantiles: boolean }): string =>
	`      queueConsumers: queueConsumerMetricsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        avg { concurrency sampleInterval }
        dimensions { datetimeFiveMinutes queueId }
      }`

const QueueConsumersGroup = Schema.Struct({
	avg: nullable(Schema.Struct({ concurrency: nullableNumber, sampleInterval: nullableNumber })),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		queueId: Schema.String,
	}),
})
export type QueueConsumersGroupShape = typeof QueueConsumersGroup.Type

const QueueConsumersAccountNode = Schema.Struct({ queueConsumers: nullable(Schema.Array(QueueConsumersGroup)) })
export const decodeQueueConsumersAccountNode = Schema.decodeUnknownEffect(QueueConsumersAccountNode)

// ---------------------------------------------------------------------------
// Durable Objects (account-scoped durableObjectsInvocationsAdaptiveGroups)
// ---------------------------------------------------------------------------

const DO_QUANTILES_SELECTION = `
        quantiles {
          wallTimeP50
          wallTimeP99
        }`

export const durableObjectsSelection = (options: { readonly withQuantiles: boolean }): string =>
	`      durableObjects: durableObjectsInvocationsAdaptiveGroups(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        sum { requests errors }${options.withQuantiles ? DO_QUANTILES_SELECTION : ""}
        dimensions { datetimeFiveMinutes scriptName }
      }`

const DurableObjectsGroup = Schema.Struct({
	sum: nullable(Schema.Struct({ requests: nullableNumber, errors: nullableNumber })),
	quantiles: nullable(Schema.Struct({ wallTimeP50: nullableNumber, wallTimeP99: nullableNumber })),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		scriptName: Schema.String,
	}),
})
export type DurableObjectsGroupShape = typeof DurableObjectsGroup.Type

const DurableObjectsAccountNode = Schema.Struct({ durableObjects: nullable(Schema.Array(DurableObjectsGroup)) })
export const decodeDurableObjectsAccountNode = Schema.decodeUnknownEffect(DurableObjectsAccountNode)

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

export const workersSelection = (options: { readonly withQuantiles: boolean }): string =>
	`      invocations: workersInvocationsAdaptive(
        limit: ${GROUP_LIMIT}
        filter: { datetime_geq: $start, datetime_lt: $end }
      ) {
        sum { requests errors subrequests }${options.withQuantiles ? WORKERS_QUANTILES_SELECTION : ""}
        dimensions { datetimeFiveMinutes scriptName status }
      }`

const WorkersQuantiles = Schema.Struct({
	cpuTimeP50: nullableNumber,
	cpuTimeP99: nullableNumber,
	durationP50: nullableNumber,
	durationP99: nullableNumber,
})

const WorkersGroup = Schema.Struct({
	sum: nullable(
		Schema.Struct({
			requests: nullableNumber,
			errors: nullableNumber,
			subrequests: nullableNumber,
		}),
	),
	quantiles: nullable(WorkersQuantiles),
	dimensions: Schema.Struct({
		datetimeFiveMinutes: Schema.String,
		scriptName: Schema.String,
		status: nullableString,
	}),
})
export type WorkersGroupShape = typeof WorkersGroup.Type

const WorkersAccountNode = Schema.Struct({ invocations: nullable(Schema.Array(WorkersGroup)) })

export const decodeWorkersAccountNode = Schema.decodeUnknownEffect(WorkersAccountNode)

// ---------------------------------------------------------------------------
// Live top-traffic lookup (host/path) — served on demand, never stored
// ---------------------------------------------------------------------------

/**
 * Top hosts or paths for ONE zone over a window, straight from Cloudflare. Path cardinality is
 * far too high to store as metric attributes, so the API proxies this per request (edge-cached
 * briefly) instead of reading the warehouse. Two selections: `top` ranks by total traffic,
 * `errors` re-ranks the 5xx slice so error counts survive even when a key's total traffic
 * doesn't make the top N. The limit is inlined (server-sanitized) — Cloudflare's `limit`
 * argument takes a literal, and keeping the document variable-free apart from the window
 * makes the two selections symmetric.
 */
export const topTrafficQuery = (options: {
	readonly dimension: "host" | "path"
	readonly limit: number
}): string => {
	const dimension = options.dimension === "host" ? "clientRequestHTTPHost" : "clientRequestPath"
	const limit = Math.floor(options.limit)
	return `query MapleCfTopTraffic($zoneTags: [string!], $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      top: httpRequestsAdaptiveGroups(
        limit: ${limit}
        filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball" }
        orderBy: [count_DESC]
      ) {
        count
        avg { sampleInterval }
        sum { edgeResponseBytes }
        dimensions { ${dimension} }
      }
      errors: httpRequestsAdaptiveGroups(
        limit: ${limit}
        filter: { datetime_geq: $start, datetime_lt: $end, requestSource: "eyeball", edgeResponseStatus_geq: 500 }
        orderBy: [count_DESC]
      ) {
        count
        avg { sampleInterval }
        dimensions { ${dimension} }
      }
    }
  }
}`
}

const TopTrafficGroup = Schema.Struct({
	count: Schema.Number,
	avg: nullable(Schema.Struct({ sampleInterval: nullableNumber })),
	sum: nullable(Schema.Struct({ edgeResponseBytes: nullableNumber })),
	dimensions: Schema.Struct({
		clientRequestHTTPHost: nullableString,
		clientRequestPath: nullableString,
	}),
})
export type TopTrafficGroupShape = typeof TopTrafficGroup.Type

const TopTrafficResponse = Schema.Struct({
	viewer: Schema.Struct({
		zones: nullable(
			Schema.Array(
				Schema.Struct({
					top: nullable(Schema.Array(TopTrafficGroup)),
					errors: nullable(Schema.Array(TopTrafficGroup)),
				}),
			),
		),
	}),
})

export const decodeTopTrafficResponse = Schema.decodeUnknownEffect(TopTrafficResponse)

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/** Cloudflare's `Time` scalar accepts RFC 3339; second precision keeps documents stable. */
export const toGraphqlTime = (epochMs: number): string =>
	new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace(".000Z", "Z")
