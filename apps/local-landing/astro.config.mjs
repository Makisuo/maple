// @ts-check
import { defineConfig } from "astro/config"
import mdx from "@astrojs/mdx"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

// https://astro.build/config
export default defineConfig({
	site: "https://maplelocal.dev",
	trailingSlash: "ignore",
	markdown: {
		shikiConfig: {
			theme: "vitesse-dark",
			wrap: true,
		},
	},
	integrations: [
		mdx(),
		react(),
		sitemap({
			// Stamp a build-time lastmod so the sitemap exposes a freshness signal.
			serialize(item) {
				item.lastmod = new Date().toISOString()
				return item
			},
		}),
	],
	vite: {
		plugins: [tailwindcss()],
		envDir: "../../",
	},
})
