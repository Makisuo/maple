import * as Flag from "effect/unstable/cli/Flag"

export const service = Flag.optional(
  Flag.string("service").pipe(
    Flag.withAlias("s"),
    Flag.withDescription("Filter by service name"),
  ),
)

export const since = Flag.string("since").pipe(
  Flag.withDescription("Relative time range (e.g. 30m, 1h, 6h, 24h, 7d)"),
  Flag.withDefault("6h"),
)

export const start = Flag.optional(
  Flag.string("start").pipe(
    Flag.withDescription("Absolute start time (YYYY-MM-DD HH:mm:ss)"),
  ),
)

export const end = Flag.optional(
  Flag.string("end").pipe(
    Flag.withDescription("Absolute end time (YYYY-MM-DD HH:mm:ss)"),
  ),
)

export const limit = Flag.integer("limit").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Maximum number of results"),
  Flag.withDefault(20),
)

export const environment = Flag.optional(
  Flag.string("env").pipe(
    Flag.withAlias("e"),
    Flag.withDescription("Filter by deployment environment (e.g. production, staging)"),
  ),
)

export const json = Flag.boolean("json").pipe(
  Flag.withDescription("Output as JSON"),
  Flag.withDefault(false),
)

export const attr = Flag.optional(
  Flag.keyValuePair("attr").pipe(
    Flag.withAlias("a"),
    Flag.withDescription("Attribute filter as key=value (repeatable, e.g. --attr user.id=abc)"),
  ),
)

export const offset = Flag.integer("offset").pipe(
  Flag.withDescription("Pagination offset"),
  Flag.withDefault(0),
)
