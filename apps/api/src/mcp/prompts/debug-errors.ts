import { McpServer } from "effect/unstable/ai"
import { Effect, Schema } from "effect"

export const DebugErrorsPrompt = McpServer.prompt({
  name: "debug_errors",
  description: "Step-by-step workflow to investigate error spikes in a service",
  parameters: {
    service_name: Schema.optional(Schema.String),
    time_range: Schema.optional(Schema.String),
  },
  content: ({ service_name, time_range }) =>
    Effect.succeed(
      `Investigate errors${service_name ? ` in service "${service_name}"` : ""}${time_range ? ` over the last ${time_range}` : ""}:\n\n` +
      `1. Call \`list_services\` to see which services are active and their error rates\n` +
      `2. Call \`find_errors\`${service_name ? ` with service="${service_name}"` : ""} to categorize error types by frequency\n` +
      `3. For the top error type, call \`error_detail\` with the error_type to get sample traces and error trends\n` +
      `4. Call \`inspect_trace\` on a sample trace_id to find the root span causing the error\n` +
      `5. Call \`service_map\`${service_name ? ` with service_name="${service_name}"` : ""} to check if upstream dependencies are involved\n` +
      `6. Summarize: root cause, affected services, error frequency, and recommended action`,
    ),
})
