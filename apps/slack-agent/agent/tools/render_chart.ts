import { defineTool } from "eve/tools"
import { z } from "zod"
import { renderChartToThread } from "#lib/render-chart.js"

/**
 * Renders a time-series chart as a PNG and posts it into the current Slack
 * thread (beyond chat-flue parity — chat-flue renders no images anywhere).
 *
 * Render happens in-process (hand-rolled SVG → @resvg/resvg-js), no headless
 * browser or external chart service — an external URL-based renderer would
 * leak org telemetry into URLs. Delivery is Slack's external-upload flow with
 * the per-team bot token, so the image lives in the customer's workspace under
 * Slack's ACLs. On render/upload failure the tool degrades to a Unicode
 * sparkline the model can inline in its reply.
 *
 * THE FILENAME IS THE TOOL NAME. eve derives it from the path with no
 * kebab→snake normalization and `defineTool()` takes no `name` field, so
 * renaming this file to `render-chart.ts` silently renames the tool while
 * `agent/instructions.md` still tells the model to call `render_chart` —
 * i.e. an unreachable tool, no error anywhere. Behaviour lives in
 * `agent/lib/render-chart.ts` (every module under `agent/tools/` registers as
 * a tool, so helpers cannot live here); this file stays the adapter from
 * eve's tool contract to it.
 */

const inputSchema = z.object({
	title: z
		.string()
		.min(1)
		.max(120)
		.describe('Human-readable chart title, e.g. "Checkout p95 latency". Never a raw metric name.'),
	kind: z
		.enum(["line", "area", "bar"])
		.describe(
			"line for latency/percentiles/gauges, area for throughput/error counts/rates, bar only for a small number of buckets.",
		),
	unit: z
		.enum(["number", "percent", "duration_ms", "bytes", "requests_per_sec"])
		.describe(
			"Unit of the values; drives axis and label formatting. percent values are " +
				"percentage points on the 0–100 scale: pass 3.2 for 3.2%. Maple tools " +
				"report rates (errorRate, hit rates) as fractions of 1 — always multiply " +
				"them by 100 before charting as percent (0.0004 → 0.04).",
		),
	// Not z.tuple(): tuples serialize to the draft-07 `items: [..]` array form,
	// which Workers AI rejects as an invalid 2020-12 tool schema.
	// .finite() because bare z.number() admits Infinity/-Infinity, which turn
	// into NaN SVG coordinates downstream.
	points: z
		.array(z.array(z.number().finite()).length(2))
		.min(1)
		.max(500)
		.describe(
			"[epochMillis, value] pairs from data you already fetched via the Maple tools. Never invent values.",
		),
})

export default defineTool({
	description:
		"Render a time-series chart (PNG) from data you already fetched and post it " +
		"into the current Slack thread. Use it when a trend is the finding — a latency " +
		"spike, an error-rate step, a throughput drop. The image is posted directly; " +
		"do not describe the chart again after calling this. Falls back to returning " +
		"a text sparkline for you to include when the image cannot be rendered or uploaded.",
	inputSchema,
	async execute(input, ctx) {
		return renderChartToThread(
			{
				title: input.title,
				kind: input.kind,
				unit: input.unit,
				points: input.points.map((p): [number, number] => [p[0]!, p[1]!]),
			},
			{
				id: ctx.session.id,
				attributes: ctx.session.auth.current?.attributes ?? {},
			},
		)
	},
})
