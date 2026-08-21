/**
 * The alert chart image, served by the SPA's own Worker.
 *
 * Same shape as `renderShareOgImage`, and for the same reasons: the API owns
 * every judgement (does this id verify, what series may it read), and this
 * module only draws what it is handed. It exists on the web origin rather than
 * the API's because that is where the takumi wasm and the Geist fonts already
 * are — one renderer, two images.
 *
 * The fetchers of this URL are Slack's and Discord's servers and whatever mail
 * client opens the email. None of them holds a Maple credential, which is why
 * the endpoint behind it is unauthenticated and the id is signed instead.
 */
import { alertChartCardNode, ALERT_CARD_HEIGHT, ALERT_CARD_WIDTH } from "./alert-chart-card"
import { renderNode, type AssetFetcher } from "./render"
import type { StaticChartSpec } from "@maple/widgets/chart/static-chart"

/** The API has to answer before an image request is worth abandoning. */
const API_TIMEOUT_MS = 4000

interface AlertChartSeriesResponse {
	readonly title: string
	readonly unit: StaticChartSpec["unit"]
	readonly kind: StaticChartSpec["kind"]
	readonly points: ReadonlyArray<readonly [number, number]>
	readonly threshold: number | null
	readonly breachSide: StaticChartSpec["breachSide"]
}

/**
 * 404 with no body for everything that is not a renderable chart — a tampered
 * id, a window whose checks have aged out, an API that did not answer. Uniform
 * for the same reason the share image is: the status must not tell whoever kept
 * a copy of the URL which of those it was.
 */
export const renderAlertChartImage = async (
	apiBaseUrl: string,
	chartId: string,
	assets: AssetFetcher,
): Promise<Response> => {
	const notFound = new Response(null, { status: 404 })

	let series: AlertChartSeriesResponse
	try {
		const response = await fetch(new URL("/v2/share/alert-chart", apiBaseUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chartId }),
			signal: AbortSignal.timeout(API_TIMEOUT_MS),
		})
		if (!response.ok) return notFound
		series = (await response.json()) as AlertChartSeriesResponse
	} catch {
		return notFound
	}

	if (series.points.length === 0) return notFound

	let png: Uint8Array
	try {
		png = await renderNode(alertChartCardNode(series), assets, {
			width: ALERT_CARD_WIDTH,
			height: ALERT_CARD_HEIGHT,
		})
	} catch {
		// A render that throws must not become a 500 in a chat client's image
		// slot, where it shows as a broken-image glyph next to a real alert.
		return notFound
	}

	return new Response(png as BodyInit, {
		headers: {
			"content-type": "image/png",
			// The window is pinned by the signature and `alert_checks` is
			// append-only, so these bytes are immutable — the long edge TTL is what
			// keeps a link doing the rounds in a channel to one warehouse read.
			"cache-control": "public, max-age=3600, s-maxage=604800, immutable",
		},
	})
}
