import {
  McpQueryError,
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
import { formatTable, truncate } from "../lib/format"
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

export function registerListAlertIncidentsTool(server: McpToolRegistrar) {
  server.tool(
    "list_alert_incidents",
    "List alert incidents (triggered alerts). Shows rule name, severity, status (open/resolved), observed value vs threshold, and timestamps. Supports filtering by status, severity, and service.",
    Schema.Struct({
      status: optionalStringParam("Filter by status: open, resolved (default: all)"),
      severity: optionalStringParam("Filter by severity: warning, critical"),
      service_name: optionalStringParam("Filter incidents by service name"),
      limit: optionalNumberParam("Max results to return (default 50)"),
    }),
    ({ status, severity, service_name, limit }) =>
      Effect.gen(function* () {
        const tenant = yield* resolveTenant
        const alerts = yield* AlertsService

        const result = yield* alerts.listIncidents(tenant.orgId).pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "list_alert_incidents",
              }),
          ),
        )

        let incidents = result.incidents

        if (status) {
          incidents = incidents.filter((i) => i.status === status)
        }
        if (severity) {
          incidents = incidents.filter((i) => i.severity === severity)
        }
        if (service_name) {
          incidents = incidents.filter((i) => i.serviceName === service_name)
        }

        const maxResults = limit ?? 50
        incidents = incidents.slice(0, maxResults)

        const openCount = incidents.filter((i) => i.status === "open").length
        const resolvedCount = incidents.filter((i) => i.status === "resolved").length

        const lines: string[] = [
          `=== Alert Incidents ===`,
          `Total: ${incidents.length} (${openCount} open, ${resolvedCount} resolved)`,
          ``,
        ]

        if (incidents.length === 0) {
          lines.push("No alert incidents found.")
        } else {
          const headers = ["Rule", "Severity", "Status", "Signal", "Condition", "Value", "Triggered"]
          const rows = incidents.map((i) => [
            truncate(i.ruleName, 30),
            i.severity,
            i.status,
            i.signalType,
            `${comparatorLabel[i.comparator] ?? i.comparator} ${i.threshold}`,
            i.lastObservedValue != null ? String(i.lastObservedValue) : "—",
            i.firstTriggeredAt.slice(0, 19),
          ])
          lines.push(formatTable(headers, rows))
        }

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "list_alert_incidents",
            data: {
              incidents: incidents.map((i) => ({
                id: i.id,
                ruleId: i.ruleId,
                ruleName: i.ruleName,
                serviceName: i.serviceName,
                signalType: i.signalType,
                severity: i.severity,
                status: i.status,
                threshold: i.threshold,
                comparator: i.comparator,
                firstTriggeredAt: i.firstTriggeredAt,
                resolvedAt: i.resolvedAt,
                lastObservedValue: i.lastObservedValue,
              })),
              total: incidents.length,
              openCount,
              resolvedCount,
            },
          }),
        }
      }),
  )
}
