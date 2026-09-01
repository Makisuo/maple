/**
 * Where each app lives in local dev.
 *
 * `bun dev` (`scripts/dev.ts`) reserves a free port per app, registers a
 * portless route at it, and publishes both through the environment; the
 * alchemy stack and the apps' own configs only read what they were handed.
 * Nothing pins a port, deliberately: several worktrees run the same app at
 * once, each reachable by name, which is the whole reason this repo uses
 * portless. A pinned port would reintroduce exactly the collision it removes.
 */

/** Every app `bun dev` can run, in the order the script lists them. */
export const DEV_APPS = [
	"api",
	"alerting",
	"electric-sync",
	"web",
	"landing",
	"ingest",
	"local-ui",
	"scraper",
] as const

export type DevApp = (typeof DEV_APPS)[number]

export const isDevApp = (value: string): value is DevApp =>
	(DEV_APPS as ReadonlyArray<string>).includes(value)

/** Comma-separated subset of `DEV_APPS` this `alchemy dev` run was asked for; unset = all. */
export const DEV_APPS_ENV_KEY = "MAPLE_DEV_APPS"

const envSuffix = (app: DevApp): string => app.replaceAll("-", "_").toUpperCase()

/** Env var carrying the port `scripts/dev.ts` reserved for `app`. */
export const devPortEnvKey = (app: DevApp): string => `MAPLE_DEV_PORT_${envSuffix(app)}`

/** Env var carrying the URL `app` answers at — the portless route, or the raw port without one. */
export const devUrlEnvKey = (app: DevApp): string => `MAPLE_DEV_URL_${envSuffix(app)}`

/**
 * The apps this `alchemy dev` run serves. Every app unless `bun dev` was given
 * a subset (`bun dev api web`); names the script does not know never reach
 * here, so an unknown entry is simply dropped.
 */
export const selectedDevApps = (): ReadonlySet<DevApp> => {
	const raw = process.env[DEV_APPS_ENV_KEY]?.trim()
	if (!raw) return new Set(DEV_APPS)
	const selected = raw
		.split(",")
		.map((name) => name.trim())
		.filter(isDevApp)
	return selected.length > 0 ? new Set(selected) : new Set(DEV_APPS)
}

export interface DevEndpoint {
	readonly port: number
	readonly url: string
}

/** Port + URL `scripts/dev.ts` handed `app`, or undefined under a bare `alchemy dev`. */
export const devEndpoint = (app: DevApp): DevEndpoint | undefined => {
	const raw = process.env[devPortEnvKey(app)]?.trim()
	if (!raw) return undefined
	const port = Number(raw)
	if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return undefined
	return { port, url: process.env[devUrlEnvKey(app)]?.trim() || `http://127.0.0.1:${port}` }
}

/**
 * The `dev` block for a Worker that `alchemy dev` serves, or `undefined` to let
 * alchemy choose a port (a bare `alchemy dev`, no portless).
 */
export const devServer = (app: DevApp): { host: string; port: number; strictPort: boolean } | undefined => {
	const endpoint = devEndpoint(app)
	if (!endpoint) return undefined
	// strictPort because the port came from an already-registered portless
	// route: silently landing on a different one would leave that route
	// pointing at nothing.
	return { host: "127.0.0.1", port: endpoint.port, strictPort: true }
}

/**
 * The URL of a sibling app, derived from this app's own `PORTLESS_URL`
 * (`https://web.localhost` → `https://api.localhost`, branch prefix included).
 * How vite/astro configs find the api and ingest without anyone pinning ports.
 */
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
