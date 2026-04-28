import * as Command from "effect/unstable/cli/Command"
import { list } from "./list"
import { detail } from "./detail"

export const errors = Command.make("errors").pipe(
	Command.withDescription("Find and investigate errors"),
	Command.withSubcommands([list, detail]),
)
