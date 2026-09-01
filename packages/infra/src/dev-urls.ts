export const siblingUrl = (target: string): string | undefined => {
	const self = process.env.PORTLESS_URL
	if (!self) return undefined
	const url = new URL(self)
	const parts = url.hostname.split(".")
	const localhostIdx = parts.lastIndexOf("localhost")
	if (localhostIdx < 1) return undefined
	parts[localhostIdx - 1] = target
	return `${url.protocol}//${parts.join(".")}${url.port ? `:${url.port}` : ""}`
}

/**
 * The `dev` block for a Worker that `alchemy dev` serves, or `undefined` to let
 * alchemy choose.
 *
 * Ports are NOT fixed, deliberately. Portless's whole point is that nobody has
 * to care which port anything is on — several worktrees run the same app at
 * once, each reachable by name. A pinned port would reintroduce exactly the
 * collision portless removes. So `scripts/dev-workers.ts` allocates a free port
 * per Worker, publishes it here as `MAPLE_DEV_PORT_<APP>`, and registers the
 * matching portless route; the stack only reads what it was handed.
 *
 * With no env var set (a bare `alchemy dev`, no portless), this returns
 * undefined and alchemy picks its own port.
 */
export const devServer = (app: string): { host: string; port: number; strictPort: boolean } | undefined => {
	const raw = process.env[devPortEnvKey(app)]?.trim()
	if (!raw) return undefined
	const port = Number(raw)
	if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined
	// strictPort because the port came from an already-registered portless
	// route: silently landing on a different one would leave that route
	// pointing at nothing.
	return { host: "127.0.0.1", port, strictPort: true }
}

/** Env var carrying the port `dev-workers.ts` reserved for `app`. */
export const devPortEnvKey = (app: string): string =>
	`MAPLE_DEV_PORT_${app.replaceAll("-", "_").toUpperCase()}`
