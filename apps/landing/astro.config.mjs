// @ts-check
import fs from "node:fs"
import path from "node:path"
import { defineConfig } from "astro/config"
import { transformerNotationDiff, transformerNotationHighlight } from "@shikijs/transformers"
import { unified } from "@astrojs/markdown-remark"
import mdx from "@astrojs/mdx"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"
import { siblingUrl } from "../../packages/infra/src/dev-urls.ts"

/**
 * Root `.env` values, read directly rather than through Vite's `loadEnv`:
 * importing `vite` here pulls a second copy of its types into `astro check` and
 * the plugin types stop unifying with the one Astro ships.
 */
const rootEnv = readRootEnv()

function readRootEnv() {
	const values = {}
	for (const file of [".env", ".env.local"]) {
		const filePath = path.resolve(import.meta.dirname, "../..", file)
		if (!fs.existsSync(filePath)) continue
		for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
			if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "")
		}
	}
	return values
}

/**
 * Client telemetry config, resolved the same way `apps/web/vite.config.ts` does
 * it: deploy-time `process.env` wins, the root `.env*` is the local fallback,
 * and under portless the ingest sibling is derived rather than hand-configured.
 * The ingest key is shared with the web app (`MAPLE_OTEL_PUBLIC_INGEST_KEY`) so
 * both surfaces report into one org and a visitor's marketing and product
 * sessions sit side by side.
 */
const telemetryEnv = {
	"import.meta.env.PUBLIC_MAPLE_INGEST_KEY": JSON.stringify(
		process.env.PUBLIC_MAPLE_INGEST_KEY?.trim() || rootEnv.MAPLE_OTEL_PUBLIC_INGEST_KEY?.trim() || "",
	),
	"import.meta.env.PUBLIC_INGEST_URL": JSON.stringify(
		process.env.PUBLIC_INGEST_URL?.trim() ||
			siblingUrl("ingest") ||
			rootEnv.VITE_INGEST_URL?.trim() ||
			"",
	),
	// Local dev only: browsers make `*.localhost` cookies host-only, so
	// landing.localhost and web.localhost can't share a visitor id without help.
	"import.meta.env.PUBLIC_MAPLE_COOKIE_DOMAIN": JSON.stringify(
		process.env.PUBLIC_MAPLE_COOKIE_DOMAIN?.trim() || rootEnv.PUBLIC_MAPLE_COOKIE_DOMAIN?.trim() || "",
	),
}

// https://astro.build/config
export default defineConfig({
	site: "https://maple.dev",
	trailingSlash: "ignore",
	i18n: {
		locales: ["en", "ja", "ko"],
		defaultLocale: "en",
		fallback: {
			ja: "en",
			ko: "en",
		},
		routing: {
			fallbackType: "rewrite",
		},
	},
	// Astro 7's HTML compressor strips whitespace with JSX rules by default,
	// silently joining adjacent inline elements across the marketing pages.
	compressHTML: true,
	markdown: {
		// Stay on the remark pipeline: Sätteri doesn't run the Shiki transformers
		// configured below. Revisit when the transformer story lands there.
		processor: unified(),
		shikiConfig: {
			theme: "vitesse-dark",
			wrap: true,
			// Line classes only ("diff add" / "highlighted"); the colors live in
			// global.css under .blog-content.
			transformers: [
				transformerNotationDiff({ matchAlgorithm: "v3" }),
				transformerNotationHighlight({ matchAlgorithm: "v3" }),
			],
		},
	},
	integrations: [
		mdx(),
		react(),
		sitemap({
			i18n: {
				defaultLocale: "en",
				locales: {
					en: "en",
					ja: "ja",
					ko: "ko",
				},
			},
			// Stamp a build-time lastmod so the sitemap exposes a freshness signal.
			serialize(item) {
				item.lastmod = new Date().toISOString()
				return item
			},
		}),
	],
	vite: {
		plugins: [
			tailwindcss(),
			// Keep these options in sync with the `sync:i18n` script, which compiles
			// the same output for typecheck/knip without going through Vite.
			paraglideVitePlugin({
				project: "./project.inlang",
				outdir: "./src/paraglide",
				strategy: ["url", "baseLocale"],
			}),
		],
		envDir: "../../",
		define: telemetryEnv,
	},
})
