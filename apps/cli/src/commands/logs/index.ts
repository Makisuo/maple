import * as Command from "effect/unstable/cli/Command"
import { search } from "./search"

export const logs = Command.make("logs").pipe(
	Command.withDescription("Search and filter logs"),
	Command.withSubcommands([search]),
)
