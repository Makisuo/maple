import * as Command from "effect/unstable/cli/Command"
import { keys } from "./keys"
import { values } from "./values"

export const attributes = Command.make("attributes").pipe(
	Command.withDescription("Discover available attribute keys and values"),
	Command.withSubcommands([keys, values]),
)
