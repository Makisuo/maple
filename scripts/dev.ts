/**
 * `bun dev [app ...]` — the whole local stack under ONE `alchemy dev`.
 *
 *   bun dev                      # everything
 *   bun dev api web              # just these (any of the names below)
 *
 * Everything lives in `alchemy.run.ts`: the Workers on alchemy's local
 * runtime, the other apps as `Command.Dev` children, and one `Portless.Route`
 * per app for its `https://<app>.localhost` name and port. This shim only
 * turns the argument list into `MAPLE_DEV_APPS`, tells the apps each other's
 * names, and runs `alchemy dev`.
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

// Inter-app URLs. Plain strings — a route's name is known before it exists —
// resolved by the stack on dev stages (`resolveUrl` in alchemy.run.ts) and
// read by the Workers' env. The apps reach each other by name, not port.
const crossAppEnv = {
	MAPLE_API_BASE_URL: process.env.MAPLE_API_BASE_URL ?? routeUrl("api"),
	MAPLE_ELECTRIC_SYNC_URL: process.env.MAPLE_ELECTRIC_SYNC_URL ?? routeUrl("electric-sync"),
	MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL ?? routeUrl("web"),
} satisfies Record<string, string>

// Resolved from the workspace root rather than $PATH: a spawned child does not
// inherit the `node_modules/.bin` entry `bun run` adds for the script itself.
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
		// Its own process group, so a signal to this script reaches the whole tree
		// below alchemy (its exec child, the sidecar, every dev child) the way a
		// terminal Ctrl-C would — a signal to the CLI process alone stops nothing.
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
