/**
 * Which apps `bun dev` runs, and how they find each other.
 *
 * Under `bun dev` every app sits behind a portless route
 * (`https://[<worktree>.]<app>.localhost`, a `Portless.Route` in the stack),
 * so apps reach each other by name and nobody cares about ports. The vite and
 * astro configs derive their siblings' URLs from their own `PORTLESS_URL`
 * (`siblingUrl`); the Workers get theirs from the environment `bun dev` sets.
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
