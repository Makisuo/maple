/// <reference types="vitest/config" />
import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import tanstackRouter from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { siblingUrl } from "../../packages/infra/src/dev-urls.ts"
import { versionManifest } from "./vite-plugin-version-manifest.ts"

const envDir = path.resolve(import.meta.dirname, "../..")

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, envDir, "")

	if (process.env.PORTLESS_URL) {
		process.env.VITE_API_BASE_URL ??= siblingUrl("api")
		process.env.VITE_INGEST_URL ??= siblingUrl("ingest")
		process.env.VITE_ELECTRIC_SYNC_URL ??= siblingUrl("electric-sync")
	}

	if (!process.env.VITE_MAPLE_AUTH_MODE) {
		process.env.VITE_MAPLE_AUTH_MODE = env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
	}

	if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
		process.env.VITE_CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY?.trim() || ""
	}

	if (!process.env.VITE_MAPLE_INGEST_KEY) {
		process.env.VITE_MAPLE_INGEST_KEY = env.MAPLE_OTEL_PUBLIC_INGEST_KEY?.trim() || ""
	}

	// One root-level var drives the cookie scope for both this app and the Astro
	// landing site — they only share a visitor id if they agree on the domain.
	if (!process.env.VITE_MAPLE_COOKIE_DOMAIN) {
		process.env.VITE_MAPLE_COOKIE_DOMAIN = env.PUBLIC_MAPLE_COOKIE_DOMAIN?.trim() || ""
	}

	// Vite's loadEnv gives `.env*` files higher precedence than `process.env` for
	// VITE_* keys. During a deploy build we inject VITE_* via process.env, so
	// override the Vite default with `define` to make process.env win.
	const overrideKeys = [
		"VITE_API_BASE_URL",
		"VITE_INGEST_URL",
		"VITE_ELECTRIC_SYNC_URL",
		"VITE_MAPLE_AUTH_MODE",
		"VITE_CLERK_PUBLISHABLE_KEY",
		"VITE_MAPLE_INGEST_KEY",
		// Injected at deploy time (CI sets VITE_COMMIT_SHA=github.sha); stamped onto
		// browser telemetry as `deployment.commit_sha` / `service.version`.
		"VITE_COMMIT_SHA",
		// "off" disables rrweb self-recording. The perf bench sets it via
		// process.env (playwright.config.ts) and must win over any `.env*` value,
		// or bench runs would record and post sessions to real ingest.
		"VITE_MAPLE_REPLAY",
		// Forces the visitor-id cookie's Domain=. Only needed locally, where
		// *.localhost cookies are host-only and web/landing would not share a
		// visitor id; production discovers `.maple.dev` by probing.
		"VITE_MAPLE_COOKIE_DOMAIN",
	] as const
	const define: Record<string, string> = {}
	for (const key of overrideKeys) {
		const value = process.env[key]?.trim()
		if (value) {
			define[`import.meta.env.${key}`] = JSON.stringify(value)
		}
	}

	return {
		envDir,
		// Keep the Playwright perf suite (perf/*.perf.spec.ts) out of the Vitest
		// run — it's executed separately via `bun run test:perf`.
		test: {
			include: ["src/**/*.test.{ts,tsx}"],
			setupFiles: ["./src/test-setup.ts"],
		},
		resolve: {
			tsconfigPaths: true,
		},
		define,
		plugins: [
			// Console piping forwards every browser console line into the dev server's stdout.
			devtools({ consolePiping: { enabled: false } }),
			tanstackRouter({
				target: "react",
				autoCodeSplitting: true,
				codeSplittingOptions: {
					// Loaders frequently import the warehouse query layer. Keeping them in
					// the route shell makes every route's data stack part of startup even
					// when its component is split.
					defaultBehavior: [
						["loader"],
						["component"],
						["pendingComponent"],
						["errorComponent"],
						["notFoundComponent"],
					],
				},
			}),
			tailwindcss(),
			viteReact(),
			// Reads the same `process.env` the `define` block above does, rather than
			// `import.meta.env`, because this runs in the Vite process and not in the
			// bundle. An empty value (any build that is not a deploy) makes the
			// client-side check inert — see `use-app-version.ts`.
			versionManifest(process.env.VITE_COMMIT_SHA?.trim() || ""),
		],
		build: {
			// The bundle budget reads Vite's static/dynamic import graph instead of
			// guessing relationships from hashed filenames.
			manifest: true,
		},
	}
})
