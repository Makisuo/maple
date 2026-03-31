import * as Command from "effect/unstable/cli/Command"
import { list } from "./list"
import { health } from "./health"
import { map } from "./map"
import { topOps } from "./top-ops"

export const services = Command.make("services").pipe(
  Command.withDescription("Service discovery, health, and dependencies"),
  Command.withSubcommands([list, health, map, topOps]),
)
