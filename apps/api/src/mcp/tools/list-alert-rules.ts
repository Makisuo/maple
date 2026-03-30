import {
  McpQueryError,
  optionalBooleanParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { AlertsService } from "@/services/AlertsService"

const comparatorLabel: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
}

export function registerListAlertRulesTool(server: McpToolRegistrar) {
  server.tool(
    "list_alert_rules",
    "List configured alert rules with their severity, signal type, and condition. Use list_alert_incidents to see triggered alerts.",
    Schema.Struct({
      service_name: optionalStringParam("Filter rules by service name"),
      signal_type: optionalStringParam(
        "Filter by signal type: error_rate, p95_latency, p99_latency, apdex, throughput, metric, query",
      ),
      severity: optionalStringParam("Filter by severity: warning, critical"),
      enabled_only: optionalBooleanParam("Only return enabled rules (default: false)"),
    }),
    ({ service_name, signal_type, severity, enabled_only }) =>
      Effect.gen(function* () {
        const tenant = yield* resolveTenant
        const alerts = yield* AlertsService

        const result = yield* alerts.listRules(tenant.orgId).pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "list_alert_rules",
              }),
          ),
        )

        let rules = result.rules

        if (service_name) {
          rules = rules.filter(
            (r) =>
              r.serviceName === service_name ||
              r.serviceNames.includes(service_name),
          )
        }
        if (signal_type) {
          rules = rules.filter((r) => r.signalType === signal_type)
        }
        if (severity) {
          rules = rules.filter((r) => r.severity === severity)
        }
        if (enabled_only) {
          rules = rules.filter((r) => r.enabled)
        }

        const lines: string[] = [
          `## Alert Rules`,
          `Total: ${rules.length} rule${rules.length !== 1 ? "s" : ""}`,
          ``,
        ]

        if (rules.length === 0) {
          lines.push("No alert rules found.")
        } else {
          const headers = ["Name", "Severity", "Signal", "Condition", "Enabled", "Destinations"]
          const rows = rules.map((r) => [
            r.name,
            r.severity,
            r.signalType,
            `${comparatorLabel[r.comparator] ?? r.comparator} ${r.threshold}`,
            r.enabled ? "Yes" : "No",
            String(r.destinationIds.length),
          ])
          lines.push(formatTable(headers, rows))
        }

        lines.push(formatNextSteps([
          '`list_alert_incidents` — see triggered alerts',
          '`create_alert_rule template="high_error_rate"` — create a new rule from template',
        ]))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "list_alert_rules",
            data: {
              rules: rules.map((r) => ({
                id: r.id,
                name: r.name,
                enabled: r.enabled,
                severity: r.severity,
                serviceName: r.serviceName,
                signalType: r.signalType,
                comparator: r.comparator,
                threshold: r.threshold,
                windowMinutes: r.windowMinutes,
                destinationIds: [...r.destinationIds],
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
              })),
              total: rules.length,
            },
          }),
        }
      }),
  )
}
