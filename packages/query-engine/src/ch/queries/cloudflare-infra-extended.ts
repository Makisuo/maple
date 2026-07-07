// ---------------------------------------------------------------------------
// Cloudflare infrastructure page — extended datasets
//
// Companions to cloudflare-infra.ts for the poller's newer datasets: per-host
// HTTP breakdowns (`http.host` attribute on `cloudflare.http.*`), firewall/WAF
// events (`cloudflare.firewall.events`), authoritative-DNS analytics
// (`cloudflare.dns.queries`), and the Workers-platform resources (Queues
// gauges under `cloudflare-queue/{id}`, Durable Object counters on the
// implementing `cloudflare-worker/{script}` services).
//
// Same conventions as the sibling file: counters in `metrics_sum` (5-min
// delta sums), point-in-time samples/percentiles in `metrics_gauge`, every
// numeric output through CHNumber so BYO-ClickHouse string-encoded aggregates
// decode identically to Tinybird numbers.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import {
	from,
	param,
	type ColumnAccessor,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { CHNumber } from "../schema"
import { MetricsGauge, MetricsSum } from "../tables"

const ISO_Z_FORMAT = "%Y-%m-%dT%H:%i:%S.%fZ"

// Same NaN guard as cloudflare-infra.ts.
const avgWhere = (value: CH.Expr<number>, cond: CH.Condition) =>
	CH.if_(CH.countIf(cond).gt(0), CH.avgIf(value, cond), CH.lit(0))

// ---------------------------------------------------------------------------
// Per-host HTTP breakdown (single zone)
// ---------------------------------------------------------------------------

export interface CloudflareZoneHostBreakdownOutput {
	/** Hostname (poller-capped: top N per window, tail folded into "other"). */
	readonly host: string
	readonly requests: number
	readonly errors5xx: number
	readonly cacheHits: number
	readonly bytes: number
}

export interface CloudflareZoneHostTimeseriesOutput {
	/** Bucket start, ISO-8601 UTC. */
	readonly bucket: string
	readonly host: string
	readonly requests: number
}

export const cloudflareZoneHostBreakdownRowSchema: CompiledQueryRowSchema<CloudflareZoneHostBreakdownOutput> =
	Schema.Struct({
		host: Schema.String,
		requests: CHNumber,
		errors5xx: CHNumber,
		cacheHits: CHNumber,
		bytes: CHNumber,
	})

export const cloudflareZoneHostTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneHostTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		host: Schema.String,
		requests: CHNumber,
	})

const CACHE_SERVED_STATUSES = ["hit", "stale", "revalidated", "updating"] as const

/** Host totals for one zone pseudo-service; rows predating the host attribute fold into "". */
export function cloudflareZoneHostBreakdownSQL() {
	return from(MetricsSum)
		.select(($) => ({
			host: $.Attributes.get("http.host"),
			requests: CH.sumIf($.Value, $.MetricName.eq("cloudflare.http.requests")),
			errors5xx: CH.sumIf(
				$.Value,
				$.MetricName.eq("cloudflare.http.requests").and(
					$.Attributes.get("http.status_class").eq("5xx"),
				),
			),
			cacheHits: CH.sumIf(
				$.Value,
				$.MetricName.eq("cloudflare.http.requests").and(
					$.Attributes.get("cache.status").in_(...CACHE_SERVED_STATUSES),
				),
			),
			bytes: CH.sumIf($.Value, $.MetricName.eq("cloudflare.http.bytes")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.in_("cloudflare.http.requests", "cloudflare.http.bytes"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("host")
		.orderBy(["requests", "desc"])
		.limit(50)
		.format("JSON")
}

/** Bucketed request counts per host for one zone pseudo-service. */
export function cloudflareZoneHostTimeseriesSQL() {
	return from(MetricsSum)
		.select(($) => ({
			bucket: CH.formatDateTime(
				CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
				ISO_Z_FORMAT,
			),
			host: $.Attributes.get("http.host"),
			requests: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.http.requests"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket", "host")
		.orderBy(["bucket", "asc"], ["host", "asc"])
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Firewall/WAF events (single zone)
// ---------------------------------------------------------------------------

export interface CloudflareZoneFirewallTimeseriesOutput {
	readonly bucket: string
	/** Cloudflare action: block / challenge / jschallenge / managed_challenge / skip / log / …. */
	readonly action: string
	readonly events: number
}

export interface CloudflareZoneFirewallTopOutput {
	readonly source: string
	readonly action: string
	readonly ruleId: string
	readonly host: string
	readonly events: number
}

export const cloudflareZoneFirewallTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneFirewallTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		action: Schema.String,
		events: CHNumber,
	})

export const cloudflareZoneFirewallTopRowSchema: CompiledQueryRowSchema<CloudflareZoneFirewallTopOutput> =
	Schema.Struct({
		source: Schema.String,
		action: Schema.String,
		ruleId: Schema.String,
		host: Schema.String,
		events: CHNumber,
	})

/** Bucketed security-event counts by action for one zone pseudo-service. */
export function cloudflareZoneFirewallTimeseriesSQL() {
	return from(MetricsSum)
		.select(($) => ({
			bucket: CH.formatDateTime(
				CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
				ISO_Z_FORMAT,
			),
			action: $.Attributes.get("firewall.action"),
			events: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.firewall.events"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket", "action")
		.orderBy(["bucket", "asc"], ["action", "asc"])
		.format("JSON")
}

/** Heaviest (source, action, rule, host) combinations for one zone pseudo-service. */
export function cloudflareZoneFirewallTopSQL() {
	return from(MetricsSum)
		.select(($) => ({
			source: $.Attributes.get("firewall.source"),
			action: $.Attributes.get("firewall.action"),
			ruleId: $.Attributes.get("firewall.rule_id"),
			host: $.Attributes.get("http.host"),
			events: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.firewall.events"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("source", "action", "ruleId", "host")
		.orderBy(["events", "desc"])
		.limit(25)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// DNS analytics (single zone)
// ---------------------------------------------------------------------------

export interface CloudflareZoneDnsTimeseriesOutput {
	readonly bucket: string
	/** DNS RCODE name (NOERROR / NXDOMAIN / SERVFAIL / …). */
	readonly responseCode: string
	readonly queries: number
}

export interface CloudflareZoneDnsBreakdownOutput {
	/** Query name (poller-capped: top N per window, tail folded into "other"). */
	readonly queryName: string
	readonly queries: number
	readonly nxdomain: number
}

export const cloudflareZoneDnsTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneDnsTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		responseCode: Schema.String,
		queries: CHNumber,
	})

export const cloudflareZoneDnsBreakdownRowSchema: CompiledQueryRowSchema<CloudflareZoneDnsBreakdownOutput> =
	Schema.Struct({
		queryName: Schema.String,
		queries: CHNumber,
		nxdomain: CHNumber,
	})

/** Bucketed DNS query counts by response code for one zone pseudo-service. */
export function cloudflareZoneDnsTimeseriesSQL() {
	return from(MetricsSum)
		.select(($) => ({
			bucket: CH.formatDateTime(
				CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
				ISO_Z_FORMAT,
			),
			responseCode: $.Attributes.get("dns.response_code"),
			queries: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.dns.queries"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket", "responseCode")
		.orderBy(["bucket", "asc"], ["responseCode", "asc"])
		.format("JSON")
}

/** Heaviest query names for one zone pseudo-service, with their NXDOMAIN share. */
export function cloudflareZoneDnsBreakdownSQL() {
	return from(MetricsSum)
		.select(($) => ({
			queryName: $.Attributes.get("dns.query_name"),
			queries: CH.sum($.Value),
			nxdomain: CH.sumIf($.Value, $.Attributes.get("dns.response_code").eq("NXDOMAIN")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.dns.queries"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("queryName")
		.orderBy(["queries", "desc"])
		.limit(25)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Workers-platform resources (org-wide)
// ---------------------------------------------------------------------------

export interface CloudflareQueueGaugesOutput {
	/** `cloudflare-queue/{queueId}`. */
	readonly serviceName: string
	/** Window-average backlog depth (messages). */
	readonly backlogMessages: number
	/** Window-peak backlog depth. */
	readonly backlogMessagesMax: number
	/** Window-average backlog size (bytes). */
	readonly backlogBytes: number
	/** Window-average consumer concurrency. */
	readonly consumerConcurrency: number
}

export interface CloudflareDurableObjectCountersOutput {
	/** `cloudflare-worker/{scriptName}` — DOs live on their implementing Worker's service. */
	readonly serviceName: string
	readonly requests: number
	readonly errors: number
}

export const cloudflareQueueGaugesRowSchema: CompiledQueryRowSchema<CloudflareQueueGaugesOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		backlogMessages: CHNumber,
		backlogMessagesMax: CHNumber,
		backlogBytes: CHNumber,
		consumerConcurrency: CHNumber,
	})

export const cloudflareDurableObjectCountersRowSchema: CompiledQueryRowSchema<CloudflareDurableObjectCountersOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		requests: CHNumber,
		errors: CHNumber,
	})

const QUEUE_GAUGE_METRIC_NAMES = [
	"cloudflare.queue.backlog.messages",
	"cloudflare.queue.backlog.bytes",
	"cloudflare.queue.consumer.concurrency",
] as const

const backlogMessagesCond = ($: ColumnAccessor<typeof MetricsGauge.columns>) =>
	$.MetricName.eq("cloudflare.queue.backlog.messages")

/** Queue backlog/concurrency rollup over `metrics_gauge`, one row per queue pseudo-service. */
export function cloudflareQueueGaugesSQL() {
	return from(MetricsGauge)
		.select(($) => ({
			serviceName: $.ServiceName,
			backlogMessages: avgWhere($.Value, backlogMessagesCond($)),
			backlogMessagesMax: CH.maxIf($.Value, backlogMessagesCond($)),
			backlogBytes: avgWhere($.Value, $.MetricName.eq("cloudflare.queue.backlog.bytes")),
			consumerConcurrency: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.queue.consumer.concurrency"),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...QUEUE_GAUGE_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["backlogMessagesMax", "desc"])
		.limit(500)
		.format("JSON")
}

/** Durable Object counter rollup over `metrics_sum`, one row per implementing Worker service. */
export function cloudflareDurableObjectCountersSQL() {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			requests: CH.sumIf($.Value, $.MetricName.eq("cloudflare.durable_object.requests")),
			errors: CH.sumIf($.Value, $.MetricName.eq("cloudflare.durable_object.errors")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(
				"cloudflare.durable_object.requests",
				"cloudflare.durable_object.errors",
			),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["requests", "desc"])
		.limit(500)
		.format("JSON")
}
