import * as CH from "../expr"
import { param } from "../param"
import { from } from "../query"
import { AttributeKeysHourly, AttributeValuesHourly } from "../tables"

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
