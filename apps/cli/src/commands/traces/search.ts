import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printTable, printJson, formatDurationMs } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const search = Command.make("search", {
  service: flags.service,
  since: flags.since,
  start: flags.start,
  end: flags.end,
  attr: flags.attr,
  span: Flag.optional(
    Flag.string("span").pipe(
      Flag.withDescription("Filter by span name (substring match, case-insensitive)"),
    ),
  ),
  hasError: Flag.boolean("errors-only").pipe(
    Flag.withDescription("Only show traces with errors"),
    Flag.withDefault(false),
  ),
  minDuration: Flag.optional(
    Flag.integer("min-duration").pipe(
      Flag.withDescription("Minimum duration in milliseconds"),
    ),
  ),
  maxDuration: Flag.optional(
    Flag.integer("max-duration").pipe(
      Flag.withDescription("Maximum duration in milliseconds"),
    ),
  ),
  httpMethod: Flag.optional(
    Flag.string("method").pipe(
      Flag.withDescription("Filter by HTTP method (GET, POST, etc.)"),
    ),
  ),
  traceId: Flag.optional(
    Flag.string("trace-id").pipe(
      Flag.withDescription("Find a specific trace by ID"),
    ),
  ),
  limit: flags.limit,
  offset: flags.offset,
  json: flags.json,
}).pipe(
  Command.withDescription("Search traces with filtering by service, attributes, duration, errors"),
  Command.withHandler(
    Effect.fnUntraced(function* (f) {
      const client = yield* MapleClient
      const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

      const params: Record<string, unknown> = {
        start_time: startTime,
        end_time: endTime,
        limit: f.limit,
        offset: f.offset,
      }

      if (Option.isSome(f.service)) params.any_service = f.service.value
      if (Option.isSome(f.span)) {
        params.any_span_name = f.span.value
        params.any_span_name_match_mode = "contains"
      }
      if (f.hasError) params.has_error = true
      if (Option.isSome(f.minDuration)) params.min_duration_ms = f.minDuration.value
      if (Option.isSome(f.maxDuration)) params.max_duration_ms = f.maxDuration.value
      if (Option.isSome(f.httpMethod)) params.http_method = f.httpMethod.value
      if (Option.isSome(f.traceId)) params.trace_id = f.traceId.value

      if (Option.isSome(f.attr)) {
        const entries = Object.entries(f.attr.value)
        if (entries.length > 0) {
          params.attribute_filter_key = entries[0]![0]
          params.attribute_filter_value = entries[0]![1]
        }
      }

      const result = yield* client.queryTinybird("list_traces", params)

      // MCP returns: { traceId, rootSpanName, durationMs, spanCount, services, hasError }
      const traces = result.data as Array<{
        traceId: string
        rootSpanName: string
        durationMs: number
        spanCount: number
        services: string[]
        hasError: boolean
      }>

      if (f.json) {
        yield* printJson({
          timeRange: { start: startTime, end: endTime },
          pagination: { offset: f.offset, limit: f.limit, hasMore: traces.length === f.limit },
          traces,
        })
        return
      }

      const hasMore = traces.length === f.limit

      yield* printTable({
        title: `Traces (${startTime} to ${endTime})`,
        headers: ["Trace ID", "Root Span", "Duration", "Spans", "Services", "Error"],
        rows: traces.map((t) => [
          t.traceId.slice(0, 16),
          (t.rootSpanName ?? "").length > 40 ? t.rootSpanName.slice(0, 37) + "..." : (t.rootSpanName ?? ""),
          formatDurationMs(t.durationMs, false),
          String(t.spanCount),
          (t.services ?? []).join(", "),
          t.hasError ? "ERR" : "",
        ]),
        summary: hasMore
          ? `Showing ${f.offset + 1}-${f.offset + traces.length}. More: maple traces search ... --offset ${f.offset + traces.length}`
          : `${traces.length} trace${traces.length !== 1 ? "s" : ""}`,
      })

      if (traces.length > 0) {
        yield* Console.log(`\n  Inspect: maple traces inspect ${traces[0]!.traceId}`)
      }
    }),
  ),
)
