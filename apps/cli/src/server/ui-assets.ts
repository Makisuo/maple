// Resolves bundled SPA assets for the local server. Two sources, in order:
//   1. `embeddedAssets` — baked into the `maple` binary at build time (compiled).
//   2. apps/local-ui/dist on disk — the dev fallback (`bun run … start`).
// Returns `undefined` when no SPA is available (API-only mode).

import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { AssetResolver } from "./serve"
import { embeddedAssets } from "./ui-embed.gen"

const MIME: Record<string, string> = {
	html: "text/html",
	js: "text/javascript",
	mjs: "text/javascript",
	css: "text/css",
	json: "application/json",
	map: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	txt: "text/plain",
	wasm: "application/wasm",
} satisfies Record<string, string>

const mimeFor = (path: string): string =>
	MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"

/**
 * Build an `AssetResolver`, or `undefined` when no SPA is available.
 *
 * The resolver itself must be synchronous (it is called from the `Bun.serve`
 * fetch handler), so the dev fallback reads `apps/local-ui/dist` into memory
 * once at startup rather than touching disk per request. (Trade-off: rebuilt
 * dev assets require a server restart to be picked up — fine for a dev-only
 * fallback. The compiled binary uses `embeddedAssets` and never reads disk.)
 */
export const resolveUiAssets = (): Effect.Effect<AssetResolver | undefined, never, FileSystem> =>
	Effect.gen(function* () {
		if (embeddedAssets) {
			const assets = embeddedAssets
			return (path) => {
				const hit = assets.get(path)
				return hit ? { body: hit.data, contentType: hit.contentType } : undefined
			}
		}

		// Dev: preload apps/local-ui/dist if it has been built.
		const fs = yield* FileSystem
		const distDir = fileURLToPath(new URL("../../../local-ui/dist/", import.meta.url))
		if (!(yield* fs.exists(distDir).pipe(Effect.orElseSucceed(() => false)))) return undefined

		const entries = yield* fs
			.readDirectory(distDir, { recursive: true })
			.pipe(Effect.orElseSucceed(() => [] as Array<string>))
		const preloaded = new Map<string, { readonly body: Uint8Array; readonly contentType: string }>()
		yield* Effect.forEach(
			entries,
			(rel) =>
				Effect.gen(function* () {
					const info = yield* fs.stat(join(distDir, rel))
					if (info.type !== "File") return
					const body = yield* fs.readFile(join(distDir, rel))
					// Normalize OS path separators to the URL-style forward slashes the
					// server looks assets up by (e.g. "assets/app.js").
					preloaded.set(rel.split(sep).join("/"), { body, contentType: mimeFor(rel) })
				}).pipe(Effect.ignore),
			{ concurrency: "unbounded" },
		)
		if (preloaded.size === 0) return undefined
		return (path) => preloaded.get(path)
	})
