import { McpServer } from "effect/unstable/ai"
import { Effect, Schema } from "effect"

export const IncidentTriagePrompt = McpServer.prompt({
  name: "incident_triage",
  description: "Step-by-step workflow to triage an active incident and identify root cause",
  parameters: {
    service_name: Schema.optional(Schema.String),
    time_range: Schema.optional(Schema.String),
  },
  content: ({ service_name, time_range }) =>
    Effect.succeed(
      `Triage an incident${service_name ? ` affecting service "${service_name}"` : ""}${time_range ? ` over the last ${time_range}` : ""}:\n\n` +
      `1. Call \`list_services\` to see all services with error rates and latency — identify the most affected\n` +
      `2. Call \`list_alert_incidents\` with status="open" to see what alerts are firing\n` +
      `3. Call \`find_errors\`${service_name ? ` with service="${service_name}"` : ""} to identify the dominant error types\n` +
      `4. Call \`search_logs\`${service_name ? ` with service="${service_name}"` : ""} severity="ERROR" to find recent error logs\n` +
      `5. Call \`diagnose_service\`${service_name ? ` with service_name="${service_name}"` : " for the most affected service"} for deep health analysis\n` +
      `6. Call \`service_map\`${service_name ? ` with service_name="${service_name}"` : ""} to understand the blast radius and upstream/downstream impact\n` +
      `7. Summarize: incident scope, root cause hypothesis, affected services, and immediate action items`,
    ),
})
