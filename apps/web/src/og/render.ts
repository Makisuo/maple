/**
 * Rasterising the preview card, in the Worker.
 *
 * takumi is a Rust layout+raster engine compiled to wasm. The module is a
 * static import rather than bytes fetched at runtime because workerd refuses to
 * compile wasm it was not given as a module — `WebAssembly.compile` on fetched
 * bytes is dynamic code generation, which the runtime blocks.
 * `@takumi-rs/wasm/auto` resolves to the `workerd` export condition, which is
 * exactly that module.
 *
 * Fonts have no such restriction, so Geist is read from the deployed assets
 * (`public/og/*.ttf`, produced by `scripts/build-og-fonts.ts`) instead of being
 * bundled. Without them the card renders in takumi's built-in grotesque, which
 * is legible and is not Maple — the whole card is typography, so the typeface
 * is the design. **TrueType, not woff2**: the loader takes a woff2 buffer
 * without complaining and then ignores it.
 *
 * The renderer, the wasm instance and the fonts are module-scoped. An isolate
 * serves many requests, and re-instantiating a 3.7 MB module per image would
 * cost more than the drawing does.
 */
import init, { Renderer, type Node } from "@takumi-rs/wasm"
import wasmModule from "@takumi-rs/wasm/auto"
import { CARD_HEIGHT, CARD_WIDTH, DISPLAY_FONT, MONO_FONT } from "./card"

export interface AssetFetcher {
	fetch: (request: Request) => Promise<Response>
}

const FONTS = [
	{ name: DISPLAY_FONT, path: "/og/geist-latin.ttf" },
	{ name: MONO_FONT, path: "/og/geist-mono-latin.ttf" },
] as const

let renderer: Promise<Renderer> | undefined

const loadFont = async (assets: AssetFetcher, path: string): Promise<Uint8Array | undefined> => {
	const response = await assets.fetch(new Request(`https://assets.invalid${path}`))
	if (!response.ok) return undefined
	return new Uint8Array(await response.arrayBuffer())
}

const makeRenderer = async (assets: AssetFetcher): Promise<Renderer> => {
	await init({ module_or_path: wasmModule })
	const engine = new Renderer()

	// A missing font is not a failed render: the card still draws, in the
	// built-in face. Losing the preview entirely because an asset moved would be
	// the worse failure.
	for (const font of FONTS) {
		const data = await loadFont(assets, font.path)
		if (data !== undefined) engine.registerFont({ name: font.name, data })
	}

	return engine
}

/**
 * An image the card references by URL, already fetched.
 *
 * takumi can be handed an image loader, but this Worker resolves the one
 * external image itself so the fetch has a timeout, a size cap and a scheme
 * check around it — the URL comes from the org directory, and a renderer that
 * will fetch whatever it is pointed at is a request forgery waiting to happen.
 */
export interface EmbeddedImage {
	readonly src: string
	readonly data: Uint8Array
}

export const renderOgCard = async (
	node: Node,
	assets: AssetFetcher,
	images: ReadonlyArray<EmbeddedImage> = [],
): Promise<Uint8Array> => {
	renderer ??= makeRenderer(assets)
	const engine = await renderer
	return engine.render(node, { width: CARD_WIDTH, height: CARD_HEIGHT, images: [...images] })
}
