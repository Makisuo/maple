/** Every app `bun dev` can run. */
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

/** Workers are served by alchemy's local runtime; processes run their own `dev` script. */
export const DEV_APP_KINDS = {
	api: "worker",
	alerting: "worker",
	"electric-sync": "worker",
	web: "process",
	landing: "process",
	ingest: "process",
	"local-ui": "process",
	scraper: "process",
} satisfies Record<DevApp, "worker" | "process">

export const DEV_PROCESS_APPS: ReadonlyArray<DevApp> = DEV_APPS.filter(
	(app) => DEV_APP_KINDS[app] === "process",
)

export const isDevApp = (value: string): value is DevApp =>
	(DEV_APPS as ReadonlyArray<string>).includes(value)

/** Comma-separated subset of `DEV_APPS` this `alchemy dev` run was asked for; unset = all. */
export const DEV_APPS_ENV_KEY = "MAPLE_DEV_APPS"

/** The apps this dev run serves: all of them unless `bun dev` named a subset. */
export const selectedDevApps = (): ReadonlySet<DevApp> => {
	const raw = process.env[DEV_APPS_ENV_KEY]?.trim()
	if (!raw) return new Set(DEV_APPS)
	const selected = raw
		.split(",")
		.map((name) => name.trim())
		.filter(isDevApp)
	return selected.length > 0 ? new Set(selected) : new Set(DEV_APPS)
}

/** A sibling app's URL from this app's own `PORTLESS_URL`, branch prefix included. */
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
