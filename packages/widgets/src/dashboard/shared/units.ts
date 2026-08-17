/**
 * The unit vocabulary a widget's `display.unit` may name.
 *
 * `display.unit` stays an OPEN `Schema.String` in storage, deliberately — the
 * same reasoning `RouteWidgetDataSource.endpoint` gives. A stored widget from
 * before this list existed may hold `"GB"` or `"ms"`, and closing the stored
 * schema would turn that into a decode failure, which
 * `DashboardPersistenceService.parsePayload` escalates into a hard error on the
 * *writable* path — locking a whole dashboard out of editing over a cosmetic
 * token. So this is a catalog for authoring surfaces (the web picker, the MCP
 * schema doc, MCP input validation), not a schema.
 *
 * The list is the UNION of two things that must agree:
 *
 *   1. the arms of `formatValueByUnit` in `@maple/ui`'s `format.ts`, and
 *   2. the options the web unit picker writes.
 *
 * Those diverge on purpose: `none`, `number` and `short` have no match arm and
 * fall through to `formatNumber`, but the picker offers them and human-authored
 * widgets store them. A catalog built from the match arms alone would reject
 * every such widget on a get -> edit -> update round trip.
 *
 * `packages/ui/src/lib/format.unit-parity.test.ts` pins (1); `WIDGET_UNITS` is
 * the input to that test.
 */
export interface WidgetUnitMeta {
	readonly token: string
	readonly label: string
	/**
	 * What the *stored numbers* must already be for this token to render right.
	 *
	 * This is the field that exists because of the percent bug: `percent` and
	 * `percent_100` differ in nothing but which scale they expect, their names
	 * are inverted relative to Grafana's `percentunit`/`percent`, and picking the
	 * wrong one renders 100x off with no error anywhere.
	 */
	readonly expects: string
}

export const WIDGET_UNITS: ReadonlyArray<WidgetUnitMeta> = [
	// Ordered as the web unit pickers show them, not alphabetically.
	{ token: "none", label: "None", expects: "any number; rendered like `number`" },
	{ token: "number", label: "Number", expects: "any number; grouped thousands" },
	{
		token: "percent",
		label: "Percent (0–1)",
		// Grafana spells this one `percentunit`. The inversion is the single most
		// common authoring mistake, so it is stated on both tokens.
		expects: "a FRACTION 0–1; multiplied by 100 on render. `error_rate` is this one",
	},
	{
		token: "percent_100",
		label: "Percent (0–100)",
		expects: "already 0–100; rendered as-is. Grafana spells this one `percent`",
	},
	{
		token: "duration_ms",
		label: "Duration (ms)",
		expects: "milliseconds. The query builder's `*_duration` aggregations are already ms",
	},
	{ token: "duration_s", label: "Duration (s)", expects: "seconds" },
	{ token: "duration_us", label: "Duration (µs)", expects: "microseconds" },
	{ token: "duration_ns", label: "Duration (ns)", expects: "nanoseconds" },
	{ token: "bytes", label: "Bytes", expects: "bytes; scaled decimal (1000-base), not 1024" },
	{ token: "requests_per_sec", label: "Requests/sec", expects: "a per-second rate" },
	{ token: "short", label: "Short", expects: "any number; rendered like `number`" },
]

export const WIDGET_UNIT_TOKENS: ReadonlyArray<string> = WIDGET_UNITS.map((unit) => unit.token)

const WIDGET_UNIT_TOKEN_SET: ReadonlySet<string> = new Set(WIDGET_UNIT_TOKENS)

export const isWidgetUnit = (value: string): boolean => WIDGET_UNIT_TOKEN_SET.has(value)

/**
 * Near-misses that store fine and then render as a bare number.
 *
 * Every entry here was observed in the wild or actively recommended by the old
 * MCP instructions (`"GB"` was). Mapping them to a suggestion is what turns a
 * silently-wrong widget into a corrective message.
 */
const UNIT_SUGGESTIONS = new Map<string, string>([
	["%", "percent_100"],
	["pct", "percent_100"],
	["percentage", "percent_100"],
	["ratio", "percent"],
	["fraction", "percent"],
	["ms", "duration_ms"],
	["millisecond", "duration_ms"],
	["milliseconds", "duration_ms"],
	["us", "duration_us"],
	["microsecond", "duration_us"],
	["microseconds", "duration_us"],
	["ns", "duration_ns"],
	["nanosecond", "duration_ns"],
	["nanoseconds", "duration_ns"],
	["s", "duration_s"],
	["sec", "duration_s"],
	["secs", "duration_s"],
	["second", "duration_s"],
	["seconds", "duration_s"],
	["duration", "duration_ms"],
	["latency", "duration_ms"],
	["time", "duration_ms"],
	["b", "bytes"],
	["kb", "bytes"],
	["mb", "bytes"],
	["gb", "bytes"],
	["tb", "bytes"],
	["byte", "bytes"],
	["rps", "requests_per_sec"],
	["req/s", "requests_per_sec"],
	["/s", "requests_per_sec"],
	["count", "number"],
	["total", "number"],
])

/** The catalog token an unrecognised unit most likely meant, if any. */
export const suggestWidgetUnit = (value: string): string | undefined =>
	UNIT_SUGGESTIONS.get(value.trim().toLowerCase())
