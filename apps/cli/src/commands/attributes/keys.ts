import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const keys = Command.make("keys", {
  source: Flag.choice("source", ["traces", "metrics", "services"]).pipe(
    Flag.withDescription("Data source"),
    Flag.withDefault("traces"),
  ),
  scope: Flag.choice("scope", ["span", "resource"]).pipe(
    Flag.withDescription("Attribute scope (for traces)"),
    Flag.withDefault("span"),
  ),
  service: flags.service,
  since: flags.since,
  start: flags.start,
  end: flags.end,
  limit: flags.limit,
  json: flags.json,
}).pipe(
  Command.withDescription("Discover available attribute keys"),
  Command.withHandler(
    Effect.fnUntraced(function* (f) {
      const client = yield* MapleClient
      const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

      const result = yield* client.callTool("explore_attributes", {
        source: f.source,
        scope: f.scope,
        start_time: startTime,
        end_time: endTime,
        ...(Option.isSome(f.service) && { service_name: f.service.value }),
        limit: f.limit,
      })

      if (f.json) {
        yield* printJson(result.data ?? { text: result._text ?? result.text })
        return
      }

      const text = result._text ?? result.text
      if (text) {
        yield* Console.log(text)
      } else {
        yield* printJson(result.data ?? result)
      }
    }),
  ),
)
