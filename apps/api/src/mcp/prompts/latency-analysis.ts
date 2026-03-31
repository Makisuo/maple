import { McpServer } from "effect/unstable/ai"
import { Effect, Schema } from "effect"

export const LatencyAnalysisPrompt = McpServer.prompt({
  name: "latency_analysis",
  description: "Step-by-step workflow to investigate latency issues and performance degradation",
  parameters: {
    service_name: Schema.optional(Schema.String),
    time_range: Schema.optional(Schema.String),
  },
  content: ({ service_name, time_range }) =>
    Effect.succeed(
      `Investigate latency issues${service_name ? ` in service "${service_name}"` : ""}${time_range ? ` over the last ${time_range}` : ""}:\n\n` +
      `1. Call \`list_services\` to see P95 latency across all services and identify the slowest\n` +
      `2. Call \`find_slow_traces\`${service_name ? ` with service="${service_name}"` : ""} to find the slowest traces with percentile context\n` +
      `3. Call \`inspect_trace\` on the slowest trace_id to find which spans are the bottleneck\n` +
      `4. Call \`get_service_top_operations\`${service_name ? ` with service_name="${service_name}" metric="p95_duration"` : ""} to find which endpoints are slowest\n` +
      `5. Call \`query_data\` with source="traces" kind="timeseries" metric="p95_duration" to see latency trends over time\n` +
      `6. Call \`compare_periods\`${service_name ? ` with service_name="${service_name}"` : ""} to check if this is a regression\n` +
      `7. Summarize: bottleneck location, affected operations, regression timeline, and recommended action`,
    ),
})
