import type { MetricType } from "../../query-engine"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from } from "@maple-dev/clickhouse-builder"
import { AttributeKeysHourly, AttributeValuesHourly, MetricsSum } from "../tables"
import { resolveMetricTable } from "./query-helpers"

export interface AttributeKeysQueryOpts {
	scope: string
	limit?: number
}

export interface AttributeKeysOutput {
	readonly attributeKey: string
	readonly usageCount: number
}

export function attributeKeysQuery(opts: AttributeKeysQueryOpts) {
	return from(AttributeKeysHourly)
		.select(($) => ({
			attributeKey: $.AttributeKey,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			$.AttributeScope.eq(opts.scope),
		])
		.groupBy("attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Attribute values queries
// ---------------------------------------------------------------------------

export interface AttributeValuesOpts {
	attributeKey: string
	limit?: number
}

export interface AttributeValuesOutput {
	readonly attributeValue: string
	readonly usageCount: number
}

export function spanAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			$.AttributeScope.eq("span"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export function resourceAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			$.AttributeScope.eq("resource"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export function logAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			$.AttributeScope.eq("log"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Metric-scoped attribute discovery — reads the raw metric tables so keys and
// values are filtered to a single metric. The hourly rollups above have no
// MetricName column (and only materialize from metrics_sum), so per-metric
// scoping must scan the raw table for the metric's type.
// ---------------------------------------------------------------------------

export interface MetricScopedAttributeKeysOpts {
	metricType: MetricType
	limit?: number
}

export function metricScopedAttributeKeysQuery(opts: MetricScopedAttributeKeysOpts) {
	const { tbl } = resolveMetricTable(opts.metricType)
	return from(tbl as typeof MetricsSum)
		.select(($) => ({
			attributeKey: CH.arrayJoin(CH.mapKeys($.Attributes)),
			usageCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.eq(param.string("metricName")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("attributeKey")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

export interface MetricScopedAttributeValuesOpts {
	metricType: MetricType
	attributeKey: string
	limit?: number
}

export function metricScopedAttributeValuesQuery(opts: MetricScopedAttributeValuesOpts) {
	const { tbl } = resolveMetricTable(opts.metricType)
	return from(tbl as typeof MetricsSum)
		.select(($) => ({
			attributeValue: $.Attributes.get(opts.attributeKey),
			usageCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.eq(param.string("metricName")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.Attributes.get(opts.attributeKey).neq(""),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export function metricAttributeValuesQuery(opts: AttributeValuesOpts) {
	return from(AttributeValuesHourly)
		.select(($) => ({
			attributeValue: $.AttributeValue,
			usageCount: CH.sum($.UsageCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(param.dateTime("startTime")),
			$.Hour.lte(param.dateTime("endTime")),
			$.AttributeScope.eq("metric"),
			$.AttributeKey.eq(opts.attributeKey),
		])
		.groupBy("attributeValue")
		.orderBy(["usageCount", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}
