import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { AttributeKeysHourly } from "../tables"

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
): CHQuery<
  typeof AttributeKeysHourly.columns,
  AttributeKeysOutput,
  { orgId: string; startTime: string; endTime: string }
> {
  return from(AttributeKeysHourly)
    .select(($) => ({
      attributeKey: $.AttributeKey as unknown as CH.Expr<string>,
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
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}
