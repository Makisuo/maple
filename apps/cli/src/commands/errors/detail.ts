import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Console, Effect, Option } from "effect"
import * as flags from "../shared-flags"
import { MapleClient } from "../../services/MapleClient"
import { printJson } from "../../services/Formatter"
import { resolveTimeRange } from "../../lib/time"

export const detail = Command.make("detail", {
  errorType: Argument.string("error-type").pipe(
    Argument.withDescription("The error type/message to investigate"),
  ),
  service: flags.service,
  since: flags.since,
  start: flags.start,
  end: flags.end,
  trend: Flag.boolean("trend").pipe(
    Flag.withDescription("Include error count timeseries"),
    Flag.withDefault(false),
  ),
  limit: Flag.integer("limit").pipe(Flag.withDefault(5)),
  json: flags.json,
}).pipe(
  Command.withDescription("Get sample traces and logs for a specific error type"),
  Command.withHandler(
    Effect.fnUntraced(function* (f) {
      const client = yield* MapleClient
      const { startTime, endTime } = resolveTimeRange({ since: f.since, start: f.start, end: f.end })

      const result = yield* client.callTool("error_detail", {
        error_type: f.errorType,
        start_time: startTime,
        end_time: endTime,
        ...(Option.isSome(f.service) && { service: f.service.value }),
        include_timeseries: f.trend,
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
