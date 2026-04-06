import * as CH from "../expr"
import { param } from "../param"
import { from } from "../query"
import { AttributeKeysHourly, Traces } from "../tables"

export interface AttributeKeysQueryOpts {
  scope: string
  limit?: number
}

export interface AttributeKeysOutput {
  readonly attributeKey: string
  readonly usageCount: number
}

export function attributeKeysQuery(
  opts: AttributeKeysQueryOpts,
) {
  return from(AttributeKeysHourly)
    .select(($) => ({
      attributeKey: $.AttributeKey,
      usageCount: CH.sum($.UsageCount),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Hour.gte(param.string("startTime")),
      $.Hour.lte(param.string("endTime")),
      $.AttributeScope.eq(param.string("scope")),
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

export function spanAttributeValuesQuery(
  opts: AttributeValuesOpts,
) {
  return from(Traces)
    .select(($) => ({
      attributeValue: $.SpanAttributes.get(opts.attributeKey),
      usageCount: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      $.SpanAttributes.get(opts.attributeKey).neq(""),
    ])
    .groupBy("attributeValue")
    .orderBy(["usageCount", "desc"])
    .limit(opts.limit ?? 50)
    .format("JSON")
}

export function resourceAttributeValuesQuery(
  opts: AttributeValuesOpts,
) {
  return from(Traces)
    .select(($) => ({
      attributeValue: $.ResourceAttributes.get(opts.attributeKey),
      usageCount: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      $.ResourceAttributes.get(opts.attributeKey).neq(""),
    ])
    .groupBy("attributeValue")
    .orderBy(["usageCount", "desc"])
    .limit(opts.limit ?? 50)
    .format("JSON")
}
