/**
 * `bun dev [app ...]` — the whole local stack under ONE `alchemy dev`.
 *
 *   bun dev                      # everything
 *   bun dev api web              # just these (any of the names below)
 *
 * The Worker apps (api, alerting, electric-sync) are served by alchemy's
 * local runtime from the same `alchemy.run.ts` that deploys them. Everything
 * else (web, landing, local-ui, ingest, scraper) runs as a `Command.Dev`
 * child of the same stack — each app's own `dev` script, on a port handed
 * to it here (see `createDevProcess` in alchemy.run.ts).
 *
 * Portless is the one thing alchemy cannot do for us: named HTTPS hosts
 * (`https://api.localhost`) that several worktrees can share without anyone
 * caring about ports. So this script reserves a free port per app, registers a
 * STATIC portless route at it (`portless alias`), and passes the ports on
 * through the environment (`MAPLE_DEV_PORT_<APP>` / `MAPLE_DEV_URL_<APP>`,
 * read by `@maple/infra/dev-urls`). Linked worktrees get the branch-prefixed
 * hostnames portless itself would produce (`fix-ui.api.localhost`).
 */
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import {
	DEV_APPS,
	DEV_APPS_ENV_KEY,
	devPortEnvKey,
	devUrlEnvKey,
	isDevApp,
	type DevApp,
} from "../packages/infra/src/dev-urls.ts"

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

/** A free TCP port, chosen by the OS and released before we hand it on. */
const reservePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer()
		server.unref()
		server.on("error", reject)
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				server.close()
				reject(new Error("could not reserve a port"))
				return
			}
			server.close(() => resolve(address.port))
		})
	})

const git = (...gitArgs: string[]): string | undefined => {
	const result = spawnSync("git", gitArgs, { encoding: "utf8" })
	if (result.status !== 0) return undefined
	const value = result.stdout.trim()
	return value === "" ? undefined : value
}

/**
 * The subdomain prefix portless would give this checkout: empty in the main
 * worktree, `<branch>.` in a linked one. Mirrors `portless run`'s own rule so
 * the names here match what any other portless-managed process would get.
 */
const worktreePrefix = (): string => {
	const gitDir = git("rev-parse", "--git-dir")
	const commonDir = git("rev-parse", "--git-common-dir")
	// In the main worktree these are the same path; a linked worktree's git dir
	// lives under the common dir's `worktrees/`.
	if (!gitDir || !commonDir || gitDir === commonDir) return ""
	const branch = git("rev-parse", "--abbrev-ref", "HEAD")
	if (!branch || branch === "HEAD") return ""
	return `${branch.replaceAll("/", "-")}.`
}

const prefix = worktreePrefix()
const ports = new Map<DevApp, number>()
for (const app of selected) {
	// Ports are ephemeral (see above). A caller that genuinely needs a fixed one —
	// a browser-verification harness that cannot resolve `*.localhost` — can pin
	// it by pre-setting the same variable this script would otherwise publish.
	const pinned = Number(process.env[devPortEnvKey(app)])
	ports.set(app, Number.isSafeInteger(pinned) && pinned > 0 ? pinned : await reservePort())
}

/** Register a static portless route per app; tolerate portless being absent. */
const registerAliases = (): boolean => {
	for (const [app, port] of ports) {
		const result = spawnSync("portless", ["alias", `${prefix}${app}`, String(port), "--force"], {
			stdio: "inherit",
		})
		if (result.error || result.status !== 0) {
			console.warn(`portless alias ${prefix}${app} failed; apps still serve on 127.0.0.1:<port>`)
			return false
		}
	}
	return true
}

const aliased = registerAliases()

/** Where `app` answers. An app that is not running still gets its would-be name, so links stay right. */
const urlFor = (app: DevApp): string => {
	const port = ports.get(app)
	return aliased || port === undefined ? `https://${prefix}${app}.localhost` : `http://127.0.0.1:${port}`
}

// Inter-app URLs. The stack resolves these from the environment on dev stages
// (see `resolveUrl` in alchemy.run.ts); vite/astro derive their own from
// `PORTLESS_URL` (`siblingUrl`). The apps reach each other by name, not port.
const crossAppEnv = {
	MAPLE_API_BASE_URL: process.env.MAPLE_API_BASE_URL ?? urlFor("api"),
	MAPLE_ELECTRIC_SYNC_URL: process.env.MAPLE_ELECTRIC_SYNC_URL ?? urlFor("electric-sync"),
	MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL ?? urlFor("web"),
} satisfies Record<string, string>

const endpointEnv: Record<string, string> = {}
for (const [app, port] of ports) {
	endpointEnv[devPortEnvKey(app)] = String(port)
	endpointEnv[devUrlEnvKey(app)] = urlFor(app)
	console.log(`  ${urlFor(app).padEnd(40)} ->  127.0.0.1:${port}`)
}

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
		// below alchemy (its exec child, the local runtime, every dev child) the way
		// a terminal Ctrl-C would — a signal to the CLI process alone stops nothing.
		detached: true,
		env: {
			...process.env,
			...endpointEnv,
			...crossAppEnv,
			[DEV_APPS_ENV_KEY]: selected.join(","),
			// Dev stacks never touch the shared account state store.
			ALCHEMY_LOCAL_STATE: process.env.ALCHEMY_LOCAL_STATE ?? "1",
		},
	},
)

child.on("exit", (code) => {
	// The routes are static, so portless would keep pointing them at ports
	// nothing listens on any more. Drop them so the names read as "not running".
	if (aliased) {
		for (const app of ports.keys()) {
			spawnSync("portless", ["alias", "--remove", `${prefix}${app}`], { stdio: "ignore" })
		}
	}
	process.exit(code ?? 0)
})
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, signal)
	})
}
