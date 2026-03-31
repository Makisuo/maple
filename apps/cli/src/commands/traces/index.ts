import * as Command from "effect/unstable/cli/Command"
import { search } from "./search"
import { inspect } from "./inspect"
import { slow } from "./slow"

export const traces = Command.make("traces").pipe(
  Command.withDescription("Search, inspect, and analyze traces"),
  Command.withSubcommands([search, inspect, slow]),
)
