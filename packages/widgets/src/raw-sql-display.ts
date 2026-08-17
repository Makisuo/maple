import { Schema } from "effect"

/**
 * How a raw-SQL widget renders its result set.
 *
 * Lives here rather than beside the raw-SQL request schemas because it is a
 * *widget display* concept: `rawSqlDisplayTypeFor` in `./widget-types` maps a
 * panel type onto it, and `WidgetTypeMeta.rawSqlDisplayType` declares it per
 * panel. The execution-side schemas in `@maple/domain` import it from here.
 *
 * Note the absent members. There is no `gauge` — a gauge is a scalar on an arc,
 * the same single-row shape as a stat, so `WIDGET_TYPES.gauge` maps to `"stat"`.
 * There is no `markdown` or `list` either: neither renders SQL at all, and both
 * leave `rawSqlDisplayType` undefined rather than claiming a type that would
 * silently change what an MCP-authored widget draws.
 */
export const RawSqlDisplayType = Schema.Literals([
	"line",
	"area",
	"bar",
	"table",
	"stat",
	"pie",
	"histogram",
	"heatmap",
	"funnel",
	"hbar",
])
export type RawSqlDisplayType = Schema.Schema.Type<typeof RawSqlDisplayType>
