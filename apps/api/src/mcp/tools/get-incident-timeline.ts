import {
  McpQueryError,
  optionalNumberParam,
  optionalStringParam,
  type McpToolRegistrar,
} from "./types"
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

const statusIcon: Record<string, string> = {
  open: "🔴",
  resolved: "✅",
}

const severityIcon: Record<string, string> = {
  critical: "🔥",
  warning: "⚠️",
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—"
  return iso.slice(0, 19).replace("T", " ")
}

export function registerGetIncidentTimelineTool(server: McpToolRegistrar) {
  server.tool(
    "get_incident_timeline",
    "Get detailed incident timeline showing when alerts triggered, their observed values, and resolution status. Use after list_alert_incidents to get deeper details about specific incidents.",
    Schema.Struct({
      rule_id: optionalStringParam("Alert rule ID to filter incidents for (use list_alert_rules to find IDs)"),
      status: optionalStringParam("Filter by status: open, resolved"),
      severity: optionalStringParam("Filter by severity: warning, critical"),
      service_name: optionalStringParam("Filter by service name"),
      limit: optionalNumberParam("Max incidents to return (default 20)"),
    }),
    Effect.fn("McpTool.getIncidentTimeline")(function* ({ rule_id, status, severity, service_name, limit }) {
        const tenant = yield* resolveTenant
        const alerts = yield* AlertsService

        const result = yield* alerts.listIncidents(tenant.orgId).pipe(
          Effect.mapError(
            (error) =>
              new McpQueryError({
                message: error.message,
                pipe: "get_incident_timeline",
              }),
          ),
        )

        let incidents = result.incidents

        if (rule_id) {
          incidents = incidents.filter((i) => i.ruleId === rule_id)
        }
        if (status) {
          incidents = incidents.filter((i) => i.status === status)
        }
        if (severity) {
          incidents = incidents.filter((i) => i.severity === severity)
        }
        if (service_name) {
          incidents = incidents.filter((i) => i.serviceName === service_name)
        }

        const maxResults = limit ?? 20
        incidents = incidents.slice(0, maxResults)

        const openCount = incidents.filter((i) => i.status === "open").length
        const resolvedCount = incidents.filter((i) => i.status === "resolved").length

        const lines: string[] = [
          `## Incident Timeline`,
          `Total: ${incidents.length} (${openCount} open, ${resolvedCount} resolved)`,
          ``,
        ]

        if (incidents.length === 0) {
          lines.push("No incidents found matching the given filters.")
        } else {
          for (const inc of incidents) {
            const sIcon = statusIcon[inc.status] ?? "❓"
            const sevIcon = severityIcon[inc.severity] ?? ""
            const condition = `${comparatorLabel[inc.comparator] ?? inc.comparator} ${inc.threshold}`
            const observedValue = inc.lastObservedValue != null ? String(inc.lastObservedValue) : "—"

            lines.push(`---`)
            lines.push(`### ${sIcon} ${inc.ruleName}`)
            lines.push(`- **Status:** ${inc.status} | **Severity:** ${sevIcon} ${inc.severity}`)
            lines.push(`- **Signal type:** ${inc.signalType}`)
            if (inc.serviceName) {
              lines.push(`- **Service:** ${inc.serviceName}`)
            }
            lines.push(`- **Condition:** value ${condition}`)
            lines.push(`- **Last observed value:** ${observedValue}`)
            lines.push(`- **First triggered:** ${formatTimestamp(inc.firstTriggeredAt)}`)
            lines.push(`- **Last triggered:** ${formatTimestamp(inc.lastTriggeredAt)}`)
            if (inc.resolvedAt) {
              lines.push(`- **Resolved at:** ${formatTimestamp(inc.resolvedAt)}`)
            }
            if (inc.lastNotifiedAt) {
              lines.push(`- **Last notified:** ${formatTimestamp(inc.lastNotifiedAt)}`)
            }
            lines.push(`- **Incident ID:** \`${inc.id}\``)
            lines.push(`- **Rule ID:** \`${inc.ruleId}\``)
            lines.push(``)
          }
        }

        const nextSteps: string[] = []
        const openIncidents = incidents.filter((inc) => inc.status === "open")
        const affectedServices = [
          ...new Set(
            openIncidents
              .filter((inc) => inc.serviceName)
              .map((inc) => inc.serviceName),
          ),
        ].slice(0, 3)
        for (const svc of affectedServices) {
          nextSteps.push(`\`diagnose_service service_name="${svc}"\` — investigate this service`)
        }
        if (openIncidents.length > 0) {
          nextSteps.push('`find_errors` — search for recent errors related to open incidents')
        }
        if (nextSteps.length === 0) {
          nextSteps.push('`list_alert_rules` — review alert configuration')
        }
        lines.push(formatNextSteps(nextSteps))

        return {
          content: createDualContent(lines.join("\n"), {
            tool: "get_incident_timeline",
            data: {
              incidents: incidents.map((i) => ({
                id: i.id,
                ruleId: i.ruleId,
                ruleName: i.ruleName,
                serviceName: i.serviceName,
                signalType: i.signalType,
                severity: i.severity,
                status: i.status,
                comparator: i.comparator,
                threshold: i.threshold,
                lastObservedValue: i.lastObservedValue,
                firstTriggeredAt: i.firstTriggeredAt,
                lastTriggeredAt: i.lastTriggeredAt,
                resolvedAt: i.resolvedAt,
                lastNotifiedAt: i.lastNotifiedAt,
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
