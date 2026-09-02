/**
 * `bun dev [app ...]`: args → MAPLE_DEV_APPS, the inter-app URLs, then one
 * `alchemy dev` for the whole stack. Everything else lives in alchemy.run.ts.
 */
import { spawn } from "node:child_process"
import path from "node:path"
import { routeUrl } from "../lib/alchemy-portless/src/index.ts"
import { DEV_APPS, DEV_APPS_ENV_KEY, isDevApp, type DevApp } from "../packages/infra/src/dev-urls.ts"

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
	console.log(`usage: bun dev [app ...]\n\napps: ${DEV_APPS.join(", ")}\n\nNo app = all of them.`)
	process.exit(0)
}
const unknown = args.filter((name) => !isDevApp(name))
if (unknown.length > 0) {
	console.error(`unknown app(s): ${unknown.join(", ")}\nknown: ${DEV_APPS.join(", ")}`)
	process.exit(2)
}
const selected: ReadonlyArray<DevApp> =
	args.length > 0 ? DEV_APPS.filter((app) => args.includes(app)) : DEV_APPS

// Plain strings: a route's name is known before it exists.
const crossAppEnv = {
	MAPLE_API_BASE_URL: process.env.MAPLE_API_BASE_URL ?? routeUrl("api"),
	MAPLE_ELECTRIC_SYNC_URL: process.env.MAPLE_ELECTRIC_SYNC_URL ?? routeUrl("electric-sync"),
	MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL ?? routeUrl("web"),
	// The scraper's api URL; process env beats its `--env-file`.
	MAPLE_API_URL: process.env.MAPLE_API_URL ?? routeUrl("api"),
} satisfies Record<string, string>

// A spawned child does not inherit the `node_modules/.bin` PATH entry `bun run` adds.
const alchemyBin = path.join(import.meta.dirname, "..", "node_modules", ".bin", "alchemy")

const child = spawn(
	alchemyBin,
	[
		"dev",
		"--stage",
		process.env.MAPLE_DEV_STAGE ?? `dev_${process.env.USER ?? "local"}`,
		"--env-file",
		".env.local",
	],
	{
		stdio: "inherit",
		// Own process group: a signal to alchemy's CLI process alone stops nothing.
		detached: true,
		env: {
			...process.env,
			...crossAppEnv,
			[DEV_APPS_ENV_KEY]: selected.join(","),
			// Dev stacks never touch the shared account state store.
			ALCHEMY_LOCAL_STATE: process.env.ALCHEMY_LOCAL_STATE ?? "1",
		},
	},
)

child.on("exit", (code) => process.exit(code ?? 0))
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, signal)
	})
}
