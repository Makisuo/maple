import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  formatValue,
  renderChartSvg,
  sparkline,
  type ChartSpec,
} from "#lib/chart.js";
import { resolveBotToken } from "#lib/maple.js";
import { uploadPngToThread } from "#lib/slack-upload.js";

/**
 * Renders a time-series chart as a PNG and posts it into the current Slack
 * thread (beyond-parity — see docs/slack-agent-chat-flue-parity.md Phase 7).
 *
 * Render happens in-process (hand-rolled SVG → @resvg/resvg-js), no headless
 * browser or external chart service — an external URL-based renderer would
 * leak org telemetry into URLs. Delivery is Slack's external-upload flow with
 * the per-team bot token, so the image lives in the customer's workspace under
 * Slack's ACLs. On render/upload failure the tool degrades to a Unicode
 * sparkline the model can inline in its reply.
 */

const inputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'Human-readable chart title, e.g. "Checkout p95 latency". Never a raw metric name.',
    ),
  kind: z
    .enum(["line", "area", "bar"])
    .describe(
      "line for latency/percentiles/gauges, area for throughput/error counts/rates, bar only for a small number of buckets.",
    ),
  unit: z
    .enum(["number", "percent", "duration_ms", "bytes", "requests_per_sec"])
    .describe("Unit of the values; drives axis and label formatting."),
  // Not z.tuple(): tuples serialize to the draft-07 `items: [..]` array form,
  // which Workers AI rejects as an invalid 2020-12 tool schema.
  points: z
    .array(z.array(z.number()).length(2))
    .min(1)
    .max(500)
    .describe(
      "[epochMillis, value] pairs from data you already fetched via the Maple tools. Never invent values.",
    ),
});

const slackString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export default defineTool({
  description:
    "Render a time-series chart (PNG) from data you already fetched and post it " +
    "into the current Slack thread. Use it when a trend is the finding — a latency " +
    "spike, an error-rate step, a throughput drop. The image is posted directly; " +
    "do not describe the chart again after calling this. Falls back to returning " +
    "a text sparkline for you to include when the image cannot be rendered or uploaded.",
  inputSchema,
  async execute(input, ctx) {
    const points = input.points.map((p): [number, number] => [p[0]!, p[1]!]);
    const spec: ChartSpec = {
      title: input.title,
      kind: input.kind,
      unit: input.unit,
      points,
    };
    const values = [...points]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    const latest = values[values.length - 1]!;
    const fallback = () => ({
      posted: false as const,
      sparkline: sparkline(values),
      latest: formatValue(latest, input.unit),
      note:
        "Chart image unavailable — include the sparkline and latest value in your reply instead.",
    });

    const attributes = ctx.session.auth.current?.attributes ?? {};
    const teamId = slackString(attributes.team_id);
    const channelId = slackString(attributes.channel_id);
    const threadTs = slackString(attributes.thread_ts);
    if (!channelId) return fallback();

    try {
      const svg = renderChartSvg(spec);
      // Lazy import: @resvg/resvg-js is a native module; keep startup and
      // non-chart turns free of it.
      const { Resvg } = await import("@resvg/resvg-js");
      const png = new Resvg(svg, {
        fitTo: { mode: "zoom", value: 2 },
        // resvg 2.x's loadSystemFonts is a silent no-op on Linux without the
        // fontconfig package (fontdb reads /etc/fonts/fonts.conf to find font
        // dirs), which drops every glyph from the PNG. Point it straight at
        // the font dirs the Dockerfile populates instead; missing dirs are
        // tolerated, and loadSystemFonts stays on as the local-dev fallback.
        font: {
          loadSystemFonts: true,
          fontDirs: [
            "/usr/share/fonts/truetype/geist-mono",
            "/usr/share/fonts/truetype/dejavu",
          ],
          defaultFontFamily: "Geist Mono",
        },
      })
        .render()
        .asPng();

      const botToken = await resolveBotToken({ teamId, channelId, threadTs });
      const uploaded = await uploadPngToThread({
        botToken,
        channelId,
        threadTs,
        filename: `${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}.png`,
        title: input.title,
        png,
      });

      return {
        posted: true as const,
        fileId: uploaded.fileId,
        permalink: uploaded.permalink,
        latest: formatValue(latest, input.unit),
        note: "Chart posted to the thread as an image. Do not re-describe it point by point.",
      };
    } catch (error) {
      console.error(
        `[slack-agent] render_chart failed session=${ctx.session.id}`,
        error,
      );
      return fallback();
    }
  },
});
