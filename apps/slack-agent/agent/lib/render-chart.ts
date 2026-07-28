// Relative, not `#lib/…`: bun's test runner does not rewrite the package
// `imports` map onto .ts sources, and this module is under test.
import {
	formatValue,
	renderChartSvg,
	sparkline,
	type ChartKind,
	type ChartSpec,
	type ChartUnit,
} from "./chart.js"
import { resolveBotToken, type SlackTokenContext } from "./maple.js"
import { uploadPngToThread, type UploadedSlackFile, type UploadPngOptions } from "./slack-upload.js"

/**
 * Implementation behind `agent/tools/render_chart.ts`, kept out of
 * `agent/tools/` for two reasons: every module in that directory registers as
 * a TOOL (eve derives the name from the filename), and a `defineTool` body is
 * unreachable from a test — it only ever receives eve's own session context.
 * Lifting the logic here gives it a seam (`RenderChartDeps`) so the degrade
 * path, which is the whole point of the tool's resilience, can be exercised
 * without a native renderer or a Slack workspace.
 *
 * The tool file stays a thin adapter; behaviour lives here.
 */

export interface RenderChartInput {
	readonly title: string
	readonly kind: ChartKind
	readonly unit: ChartUnit
	/** `[epochMillis, value]` pairs, ordered or not. */
	readonly points: ReadonlyArray<readonly [number, number]>
}

/** The slice of eve's session context this tool actually reads. */
export interface RenderChartSession {
	readonly id: string
	/** Slack auth attributes: `team_id`, `channel_id`, `thread_ts`. */
	readonly attributes: Readonly<Record<string, unknown>>
}

export type RenderChartResult =
	| {
			readonly posted: true
			readonly fileId: string
			readonly permalink: string | null
			readonly latest: string
			readonly note: string
	  }
	| {
			readonly posted: false
			readonly sparkline: string
			readonly latest: string
			readonly note: string
	  }

/** Injectable dependencies so tests never render a PNG or touch the network. */
export interface RenderChartDeps {
	renderPng(spec: ChartSpec): Promise<Uint8Array>
	resolveBotToken(context: SlackTokenContext): Promise<string>
	uploadPngToThread(options: UploadPngOptions): Promise<UploadedSlackFile>
}

/**
 * Renders the SVG to PNG in-process. Lazy import: @resvg/resvg-js is a native
 * module; keep startup and non-chart turns free of it.
 */
async function renderPngWithResvg(spec: ChartSpec): Promise<Uint8Array> {
	const svg = renderChartSvg(spec)
	const { Resvg } = await import("@resvg/resvg-js")
	return new Resvg(svg, {
		fitTo: { mode: "zoom", value: 2 },
		// resvg 2.x's loadSystemFonts is a silent no-op on Linux without the
		// fontconfig package (fontdb reads /etc/fonts/fonts.conf to find font
		// dirs), which drops every glyph from the PNG. Point it straight at the
		// font dirs the Dockerfile populates instead; missing dirs are tolerated,
		// and loadSystemFonts stays on as the local-dev fallback.
		font: {
			loadSystemFonts: true,
			fontDirs: ["/usr/share/fonts/truetype/geist-mono", "/usr/share/fonts/truetype/dejavu"],
			defaultFontFamily: "Geist Mono",
		},
	})
		.render()
		.asPng()
}

export const defaultRenderChartDeps: RenderChartDeps = {
	renderPng: renderPngWithResvg,
	resolveBotToken,
	uploadPngToThread,
}

const slackString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Renders a chart and posts it into the session's Slack thread, degrading to a
 * Unicode sparkline rather than throwing.
 *
 * Degrading is deliberate: the model called this because a trend IS the
 * finding, so a thrown tool error would cost it the answer it already has. A
 * `posted: false` result still carries the shape of the data (sparkline) and
 * the latest value, which the model inlines in its reply instead.
 */
export async function renderChartToThread(
	input: RenderChartInput,
	session: RenderChartSession,
	deps: RenderChartDeps = defaultRenderChartDeps,
): Promise<RenderChartResult> {
	const points = input.points.map((p): [number, number] => [p[0], p[1]])
	const spec: ChartSpec = {
		title: input.title,
		kind: input.kind,
		unit: input.unit,
		points,
	}
	const values = [...points].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
	const latest = values[values.length - 1]!
	const fallback = (): RenderChartResult => ({
		posted: false as const,
		sparkline: sparkline(values),
		latest: formatValue(latest, input.unit),
		note: "Chart image unavailable — include the sparkline and latest value in your reply instead.",
	})

	const teamId = slackString(session.attributes.team_id)
	const channelId = slackString(session.attributes.channel_id)
	const threadTs = slackString(session.attributes.thread_ts)
	// No channel to post into (a non-Slack channel, or a session whose auth
	// attributes never carried one): there is nothing to upload to, so skip
	// straight to the text form rather than failing the turn.
	if (!channelId) return fallback()

	try {
		const png = await deps.renderPng(spec)
		const botToken = await deps.resolveBotToken({ teamId, channelId, threadTs })
		const uploaded = await deps.uploadPngToThread({
			botToken,
			channelId,
			threadTs,
			filename: `${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}.png`,
			title: input.title,
			png,
		})

		return {
			posted: true as const,
			fileId: uploaded.fileId,
			permalink: uploaded.permalink,
			latest: formatValue(latest, input.unit),
			note: "Chart posted to the thread as an image. Do not re-describe it point by point.",
		}
	} catch (error) {
		console.error(`[slack-agent] render_chart failed session=${session.id}`, error)
		return fallback()
	}
}
