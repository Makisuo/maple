/**
 * Run the Worker apps (api, alerting, electric-sync) under one `alchemy dev`.
 *
 * `alchemy dev` owns a whole stack in a single process, which does not fit
 * portless's one-script-per-app model — portless spawns a script per app and
 * hands it a port. So this inverts the relationship: we reserve a free port per
 * Worker, tell portless about it as a STATIC route (`portless alias`), and pass
 * the ports to the stack, where each app's `dev: devServer(<app>)` picks its
 * own up.
 *
 * Ports are ephemeral on purpose. Nobody should have to care which port
 * anything is on, and several worktrees must be able to run the same app at
 * once — which is the whole reason this repo uses portless. Linked worktrees
 * get the branch-prefixed hostnames portless itself would produce
 * (`fix-ui.api.localhost`), so the two naming schemes agree.
 *
 * Everything not served by a Worker (web, landing, ingest, scraper, local-ui)
 * keeps running under `turbo dev`; see `bun dev`.
 */
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import { devPortEnvKey } from "../packages/infra/src/dev-urls.ts"

/** Worker apps this script fronts. */
const WORKER_APPS = ["api", "alerting", "electric-sync"] as const

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

const git = (...args: string[]): string | undefined => {
	const result = spawnSync("git", args, { encoding: "utf8" })
	if (result.status !== 0) return undefined
	const value = result.stdout.trim()
	return value === "" ? undefined : value
}

/**
 * The subdomain prefix portless would give this checkout: empty in the main
 * worktree, `<branch>.` in a linked one. Mirrors `portless run`'s own rule so
 * the aliases we register line up with the hostnames portless hands the apps
 * it spawns itself (web, landing).
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
const ports = new Map<string, number>()
for (const app of WORKER_APPS) {
	ports.set(app, await reservePort())
}

/** Register a static portless route per Worker; tolerate portless being absent. */
const registerAliases = (): boolean => {
	for (const [app, port] of ports) {
		const result = spawnSync("portless", ["alias", `${prefix}${app}`, String(port), "--force"], {
			stdio: "inherit",
		})
		if (result.error || result.status !== 0) {
			console.warn(`portless alias ${prefix}${app} failed; workers still serve on 127.0.0.1:<port>`)
			return false
		}
	}
	return true
}

const aliased = registerAliases()
const urlFor = (app: string) =>
	aliased ? `https://${prefix}${app}.localhost` : `http://127.0.0.1:${ports.get(app)}`

// Inter-app URLs. The stack resolves these from the environment on dev stages
// (see `resolveUrl` in alchemy.run.ts), which is exactly the seam the portless
// hostnames belong in — the workers must reach each other by name, not port.
const crossAppEnv = {
	MAPLE_API_BASE_URL: process.env.MAPLE_API_BASE_URL ?? urlFor("api"),
	MAPLE_ELECTRIC_SYNC_URL: process.env.MAPLE_ELECTRIC_SYNC_URL ?? urlFor("electric-sync"),
	// web is served by vite under portless, with the same prefix rule.
	MAPLE_APP_BASE_URL: process.env.MAPLE_APP_BASE_URL ?? `https://${prefix}web.localhost`,
} satisfies Record<string, string>

const portEnv = Object.fromEntries([...ports].map(([app, port]) => [devPortEnvKey(app), String(port)]))

for (const [app, port] of ports) {
	console.log(`  ${urlFor(app)}  ->  127.0.0.1:${port}`)
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
		env: {
			...process.env,
			...portEnv,
			...crossAppEnv,
			// Dev stacks never touch the shared account state store.
			ALCHEMY_LOCAL_STATE: process.env.ALCHEMY_LOCAL_STATE ?? "1",
		},
	},
)

child.on("exit", (code) => process.exit(code ?? 0))
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		if (!child.killed) child.kill(signal)
	})
}
