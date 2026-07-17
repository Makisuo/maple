/// <reference types="vitest/config" />
import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import tanstackRouter from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { siblingUrl } from "../../packages/infra/src/dev-urls.ts"

const envDir = path.resolve(import.meta.dirname, "../..")

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, envDir, "")

	if (process.env.PORTLESS_URL) {
		process.env.VITE_API_BASE_URL ??= siblingUrl("api")
		process.env.VITE_INGEST_URL ??= siblingUrl("ingest")
		process.env.VITE_FLUE_CHAT_URL ??= siblingUrl("chat-flue")
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

	// Vite's loadEnv gives `.env*` files higher precedence than `process.env` for
	// VITE_* keys. During a deploy build we inject VITE_* via process.env, so
	// override the Vite default with `define` to make process.env win.
	const overrideKeys = [
		"VITE_API_BASE_URL",
		"VITE_INGEST_URL",
		"VITE_FLUE_CHAT_URL",
		"VITE_ELECTRIC_SYNC_URL",
		"VITE_MAPLE_AUTH_MODE",
		"VITE_CLERK_PUBLISHABLE_KEY",
		"VITE_MAPLE_INGEST_KEY",
		// Injected at deploy time (CI sets VITE_COMMIT_SHA=github.sha); stamped onto
		// browser telemetry as `deployment.commit_sha` / `service.version`.
		"VITE_COMMIT_SHA",
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
		},
		resolve: {
			tsconfigPaths: true,
		},
		define,
		plugins: [
			devtools(),
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
		],
		build: {
			// The bundle budget reads Vite's static/dynamic import graph instead of
			// guessing relationships from hashed filenames.
			manifest: true,
		},
	}
})
