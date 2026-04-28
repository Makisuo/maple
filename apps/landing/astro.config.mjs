// @ts-check
import { defineConfig } from "astro/config"
import mdx from "@astrojs/mdx"
import paraglide from "@inlang/paraglide-astro"
import react from "@astrojs/react"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"

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
	markdown: {
		shikiConfig: {
			theme: "vitesse-dark",
			wrap: true,
		},
	},
	integrations: [
		mdx(),
		paraglide({
			project: "./project.inlang",
			outdir: "./src/paraglide",
		}),
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
		}),
	],
	vite: {
		plugins: [tailwindcss()],
		envDir: "../../",
	},
})
