/**
 * `/brand.md` — the markdown twin of the brand page.
 *
 * This is the twin most likely to be fetched by something that is not a person:
 * "what colour is Maple's brand, and where do I get the logo" is a question an
 * agent gets asked while writing a README or a slide. So the asset table gives
 * absolute URLs — a relative path is useless once the file has been copied out
 * of here, which is the entire point of the twin.
 */
import type { APIRoute } from "astro"
import { absolute, blocks, docHeader, markdown, table } from "../lib/page-markdown"

export const GET: APIRoute = ({ site }) => {
	const url = (path: string) => absolute(site, path)

	const assets = [
		[
			"Lockup, primary",
			"amber mark, ink type — light grounds",
			"/brand/wordmark/maple-lockup-primary.svg",
		],
		[
			"Lockup, reversed",
			"amber mark, bone type — dark grounds",
			"/brand/wordmark/maple-lockup-reversed.svg",
		],
		["Lockup, mono ink", "single fill", "/brand/wordmark/maple-lockup-ink.svg"],
		["Lockup, mono white", "single fill", "/brand/wordmark/maple-lockup-white.svg"],
		["Wordmark only", "type alone, outlined", "/brand/wordmark/maple-wordmark-ink.svg"],
		["Mark, amber", "the default bare mark", "/brand/logo/maple-mark-amber.svg"],
		["Mark, ink", "light grounds", "/brand/logo/maple-mark-ink.svg"],
		["Mark, white", "dark grounds and photography", "/brand/logo/maple-mark-white.svg"],
		["Soot tile", "amber on ink — app icon, favicon", "/brand/logo/maple-mark-soot.svg"],
		["Fired tile", "ink on amber — Maple Local", "/brand/logo/maple-mark-fired.svg"],
	]

	return markdown(
		blocks(
			docHeader(
				"Maple brand assets",
				"The Maple logo, wordmark, colours, and type. Free to use without asking; please use the artwork as it is rather than redrawing it.",
			),

			"## Brand kit",
			`Everything below in one archive, SVG plus PNG at 256, 512, and 1024: ${url("/brand/maple-brand-kit.zip")}`,

			"## Assets",
			table(
				["Asset", "Use", "URL"],
				assets.map(([name, use, path]) => [name!, use!, url(path!)]),
			),
			"Each `.svg` has PNG siblings — append `-256`, `-512`, or `-1024` before the extension.",

			"## Colour",
			"The brand is one warm amber at hue 59 on a near-black that leans brown rather than blue. For artwork, hex is authoritative; for interface code, the oklch token in `packages/ui/src/styles/tokens.css` is.",
			table(
				["Name", "Value", "Use"],
				[
					["Amber", "`#E86F00`", "the mark"],
					["Ink", "`#171410`", "tiles and dark grounds"],
					["Bone", "`#E8E0D6`", "type on dark grounds"],
					["`--primary` (dark)", "`oklch(0.714 0.154 59)`", "brand accent in the product"],
					["`--primary` (light)", "`oklch(0.66 0.16 59)`", "brand accent, light theme"],
					["`--background` (dark)", "`oklch(0.207 0.008 67)`", "app ground"],
				],
			),

			"## Type",
			"Geist for headings, Geist Mono for body copy — the monospace body is deliberate, not a code-block rule. The wordmark is Geist Medium at -0.02em tracking, shipped as outlines so it needs no font installed. Both faces are under the SIL Open Font License.",

			"## Usage",
			blocks(
				'- **Don\'t fill the mark with a gradient.** The eyes and the notch beside the trunk are knockouts in one `fill-rule="evenodd"` path, so a gradient reaches them at a different value and they stop reading as eyes.',
				"- **Don't put the rounded tile inside your own chrome.** The tile exists to survive a browser tab strip; on a surface that already has an edge it is a box around a box. Use the bare mark.",
				'- **Don\'t rebuild the wordmark** by setting "Maple" in another face next to the mark. Use the outlined lockup.',
				"- **Don't stretch, rotate, or recolour.** Scale uniformly and pick a colourway above; if none clears your ground, use mono white or mono ink.",
				"- **Do keep clear space** of at least half the mark's width on every side.",
				"- **Do respect the 16px floor** for the bare mark — below that its eyes antialias into a blob, so use the tile instead.",
			),

			"## Terms",
			blocks(
				"Maple's source is FSL-1.1-ALv2, and each release converts to Apache 2.0 two years after we publish it. Neither one hands over the name or the artwork. The FSL says so in its own words, and Apache repeats it in its section 6. So a fork gets every line of the code and none of this page: ship it under your own name and your own mark. Saying what it is stays fine. \"A fork of Maple\", \"built on Maple\", \"compatible with Maple\" are all true, and none of them needs asking.",
				"What isn't fine is looking like us when you aren't: Maple in your product name, domain, or handle, or the mark placed so it reads as endorsement or partnership where there's no agreement. We can ask you to stop, and if we do, please stop.",
				"Maple and the Maple mark are trademarks of Makisuo, Inc. Other names and logos on this site belong to their owners.",
			),

			"## Contact",
			"Anything the kit doesn't cover — a partner lockup, a different ratio, or permission for one of the don'ts above: hello@maple.dev",

			`HTML version: ${url("/brand")}`,
		),
	)
}
