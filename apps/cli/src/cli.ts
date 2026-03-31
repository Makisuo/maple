import * as Command from "effect/unstable/cli/Command"
import { traces } from "./commands/traces/index"
import { errors } from "./commands/errors/index"
import { services } from "./commands/services/index"
import { logs } from "./commands/logs/index"
import { timeseries, breakdown, compare } from "./commands/analytics/index"
import { attributes } from "./commands/attributes/index"

export const cli = Command.make("maple").pipe(
  Command.withDescription("Maple CLI — OpenTelemetry observability from your terminal"),
  Command.withSubcommands([
    traces,
    errors,
    services,
    logs,
    timeseries,
    breakdown,
    compare,
    attributes,
  ]),
)
