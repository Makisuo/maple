import {
  McpQueryError,
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { AlertsService } from "@/services/AlertsService"
import { AlertRuleId } from "@maple/domain/http"

const decodeRuleId = Schema.decodeUnknownSync(AlertRuleId)

export function registerListAlertChecksTool(server: McpToolRegistrar) {
  server.tool(
    "list_alert_checks",
    "List recent alert rule checks (one per evaluation) with observed value, threshold, sample count, and incident linkage. Use to tune thresholds, investigate flappy rules, or correlate a breach with prior near-misses.",
    Schema.Struct({
      rule_id: Schema.String.annotate({
        description: "ID of the alert rule to inspect",
      }),
      group_key: optionalStringParam("Filter by a specific group key"),
      status: optionalStringParam(
        "Filter by check status: breached, healthy, skipped",
      ),
      since: optionalStringParam(
        "ISO8601 timestamp — only return checks at or after this time",
      ),
      until: optionalStringParam(
        "ISO8601 timestamp — only return checks at or before this time",
      ),
      limit: optionalNumberParam("Max checks to return (default 100, max 2000)"),
    }),
    Effect.fn("McpTool.listAlertChecks")(function* ({
      rule_id,
      group_key,
      status,
      since,
      until,
      limit,
    }) {
      const tenant = yield* resolveTenant
      const alerts = yield* AlertsService

      const ruleId = yield* Effect.try({
        try: () => decodeRuleId(rule_id),
        catch: () =>
          new McpQueryError({
            message: `Invalid rule_id: ${rule_id}`,
            pipe: "list_alert_checks",
          }),
      })

      const result = yield* alerts
        .listRuleChecks(tenant.orgId, ruleId, {
          groupKey: group_key,
          since,
          until,
          limit: limit ?? 100,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "list_alert_checks",
              }),
          ),
        )

      let checks = result.checks
      if (status) {
        checks = checks.filter((c) => c.status === status)
      }

      const breached = checks.filter((c) => c.status === "breached").length
      const healthy = checks.filter((c) => c.status === "healthy").length
      const skipped = checks.filter((c) => c.status === "skipped").length
      const transitions = checks.filter((c) => c.incidentTransition !== "none").length

      const lines: string[] = [
        `## Alert Checks`,
        `Rule: ${rule_id}`,
        `Total: ${checks.length} (${breached} breached · ${healthy} healthy · ${skipped} skipped · ${transitions} incident transitions)`,
        ``,
      ]

      if (checks.length === 0) {
        lines.push("No checks found for the given filters.")
      } else {
        const headers = [
          "Time",
          "Status",
          "Value",
          "Threshold",
          "Samples",
          "Group",
          "Transition",
          "Eval ms",
        ]
        const rows = checks.slice(0, 100).map((c) => [
          c.timestamp.slice(0, 19),
          c.status,
          c.observedValue != null ? String(c.observedValue) : "—",
          String(c.threshold),
          String(c.sampleCount),
          truncate(c.groupKey || "all", 20),
          c.incidentTransition,
          String(c.evaluationDurationMs),
        ])
        lines.push(formatTable(headers, rows))
        if (checks.length > 100) {
          lines.push(``, `_Showing first 100 of ${checks.length} matching checks._`)
        }
      }

      const nextSteps: string[] = []
      if (transitions > 0) {
        nextSteps.push("`list_alert_incidents` — follow up on the triggered incidents")
      }
      if (breached > 0 && transitions === 0) {
        nextSteps.push(
          "Rule breached but no incident opened — check `consecutiveBreachesRequired` in `get_alert_rule`",
        )
      }
      if (nextSteps.length === 0) {
        nextSteps.push("`get_alert_rule` — review this rule's configuration")
      }
      lines.push(formatNextSteps(nextSteps))

      return {
        content: createDualContent(lines.join("\n"), {
          tool: "list_alert_checks",
          data: {
            ruleId: rule_id,
            total: checks.length,
            breached,
            healthy,
            skipped,
            transitions,
            checks: checks.map((c) => ({
              timestamp: c.timestamp,
              groupKey: c.groupKey,
              status: c.status,
              observedValue: c.observedValue,
              threshold: c.threshold,
              comparator: c.comparator,
              sampleCount: c.sampleCount,
              windowStart: c.windowStart,
              windowEnd: c.windowEnd,
              consecutiveBreaches: c.consecutiveBreaches,
              consecutiveHealthy: c.consecutiveHealthy,
              incidentId: c.incidentId,
              incidentTransition: c.incidentTransition,
              evaluationDurationMs: c.evaluationDurationMs,
            })),
          },
        }),
      }
    }),
  )
}
