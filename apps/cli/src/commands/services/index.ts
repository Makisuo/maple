import * as Command from "effect/unstable/cli/Command"
import { list } from "./list"
import { health } from "./health"
import { map } from "./map"

export const services = Command.make("services").pipe(
  Command.withDescription("Service discovery, health, and dependencies"),
  Command.withSubcommands([list, health, map]),
)
