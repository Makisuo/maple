/**
 * Converts the app's own Geist woff2 files into the TrueType the OG card's
 * renderer can read, and writes them into `public/og/`.
 *
 * takumi's font loader takes ttf/otf. It accepts a woff2 buffer without
 * complaining and then silently ignores it — the card renders in the engine's
 * built-in face and nothing anywhere says why — so the conversion has to happen
 * before the bytes ever reach it.
 *
 * Committed output rather than a build step: the fonts change when the
 * `@fontsource-variable/geist*` dependency changes, which is roughly never, and
 * a Worker that has to decompress two woff2 files at boot to draw a preview is
 * a worse trade than 200 KB in `public/`.
 *
 *   bun run --cwd apps/web og:fonts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import decompress from "woff2-encoder/decompress"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Latin only. Every other subset falls back to takumi's built-in face. */
const FONTS = [
	{
		from: "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
		to: "public/og/geist-latin.ttf",
	},
	{
		from: "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
		to: "public/og/geist-mono-latin.ttf",
	},
] as const

for (const font of FONTS) {
	const source = readFileSync(join(root, "node_modules", font.from))
	const ttf = new Uint8Array(await decompress(source))
	const target = join(root, font.to)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, ttf)
	console.log(`${font.to}  ${source.length} → ${ttf.length} bytes`)
}
