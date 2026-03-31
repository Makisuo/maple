import * as Command from "effect/unstable/cli/Command"
import { Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printTable, printJson, formatDurationMs, formatPercent, formatNumber } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const list = Command.make("list", {
  since: flags.since,
  start: flags.start,
  end: flags.end,
  environment: flags.environment,
  json: flags.json,
}).pipe(
  Command.withDescription("List all active services with key metrics"),
  Command.withHandler(
    Effect.fnUntraced(function* ({ since, start, end, environment, json }) {
      const client = yield* MapleClient
      const { startTime, endTime } = resolveTimeRange({ since, start, end })

      const result = yield* client.queryTinybird("service_overview", {
        start_time: startTime,
        end_time: endTime,
        ...(Option.isSome(environment) && { environments: environment.value }),
      })

      // MCP returns pre-aggregated data: { name, throughput, errorRate, p95Ms }
      const services = result.data as Array<{
        name: string
        throughput: number
        errorRate: number
        p95Ms: number
      }>

      if (json) {
        yield* printJson({ timeRange: { start: startTime, end: endTime }, services })
        return
      }

      yield* printTable({
        title: `Services (${startTime} to ${endTime})`,
        headers: ["Service", "Throughput", "Error Rate", "P95 Latency"],
        rows: services.map((s) => [
          s.name,
          formatNumber(s.throughput),
          formatPercent(s.errorRate),
          formatDurationMs(s.p95Ms, false),
        ]),
        summary: `${services.length} service${services.length !== 1 ? "s" : ""} active`,
      })
    }),
  ),
)
