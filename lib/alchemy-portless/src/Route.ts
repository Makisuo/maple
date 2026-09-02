import { spawnSync } from "node:child_process"
import * as LocalProvider from "alchemy/Local/LocalProvider"
import * as ProviderLayer from "alchemy/Local/ProviderLayer"
import * as Output from "alchemy/Output"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import * as Effect from "effect/Effect"
import { choosePort, preferredPort } from "./ports.ts"
import { routeHostname, worktreePrefix } from "./worktree.ts"

export interface RouteProps {
	/** The app's name in the hostname: `api` → `https://api.localhost`. */
	name: string
	/** Hostname prefix; defaults to portless's worktree rule (`<branch>.` in a linked worktree). */
	prefix?: string
	/** Pin the port; by default it is sticky, derived from the route's identity. */
	port?: number
}

export interface RouteAttributes {
	name: string
	/** The registered hostname, without `.localhost`. */
	hostname: string
	/** Loopback host the app binds, which portless proxies to. */
	host: string
	port: number
	/** The route's URL when portless registered it; the raw loopback URL when it could not. */
	url: string
	/** False when portless is missing or its proxy is down. */
	aliased: boolean
}

/**
 * A static portless route for something `alchemy dev` runs on a loopback port:
 * reserves a sticky port (or takes the one given), registers the route, removes
 * it on teardown. A no-op on deploys.
 *
 * ```ts
 * const web = yield* Portless.Route("web-route", { name: "web" })
 * yield* Command.Dev("web-dev", { command: "bun run dev", env: { PORT: web.port } })
 * // A Worker binds its port at plan time, so its route follows the Worker:
 * const api = yield* Cloudflare.Worker("api", { dev: Portless.workerDev("api"), … })
 * yield* Portless.Route("api-route", { name: "api", port: Portless.workerPort(api.url) })
 * ```
 */
export type Route = Resource<"Portless.Route", RouteProps, RouteAttributes>

export const Route = Resource<Route>("Portless.Route")

export interface WorkerDev {
	readonly host: string
	readonly port: number
	readonly strictPort: boolean
}

/**
 * A Worker's `dev` block: alchemy binds the port in `precreate`, before Outputs
 * resolve, so it gets a sticky port up front and its route follows it (`workerPort`).
 */
export const workerDev = (name: string): WorkerDev => ({
	host: "127.0.0.1",
	port: preferredPort(`worker:${name}`),
	strictPort: false,
})

/** The port a local Worker bound, read from its `url` attribute once it is up. */
export const workerPort = (
	url: string | undefined | Output.Output<string | undefined>,
): Output.Output<number> =>
	Output.map(Output.asOutput(url), (value) => {
		if (!value) throw new Error("the Worker has no local URL to route to")
		const port = Number(new URL(value).port)
		if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`no port in the Worker's URL ${value}`)
		return port
	})

const portless = (...args: string[]): boolean => {
	const result = spawnSync("portless", args, { stdio: "ignore" })
	return !result.error && result.status === 0
}

const offline = (props: RouteProps): RouteAttributes => {
	const hostname = routeHostname(props.name, props.prefix)
	return { name: props.name, hostname, host: "127.0.0.1", port: 0, url: "", aliased: false }
}

/** Deploy-time provider: nothing to create. Routes are a dev-mode concern. */
export const RouteProviderLive = () =>
	Provider.succeed(Route, {
		diff: () => Effect.succeed({ action: "noop" as const }),
		reconcile: ({ news }) => Effect.succeed(offline(news)),
		delete: () => Effect.void,
		list: () => Effect.succeed([]),
	})

/** Dev-mode provider, in alchemy's sidecar so the route survives stack-file reloads. */
export const RouteProviderLocal = () =>
	LocalProvider.make(
		Route,
		import.meta.resolve("./Local.ts"),
		Effect.succeed({
			start: Effect.fn(function* ({ news, fqn }) {
				const prefix = news.prefix ?? worktreePrefix()
				const hostname = routeHostname(news.name, prefix)
				// Keyed by fqn: two worktrees share a preferred port and the second walks forward.
				const port = news.port ?? (yield* Effect.promise(() => choosePort(fqn)))
				const aliased = portless("alias", hostname, String(port), "--force")
				if (aliased) {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							portless("alias", "--remove", hostname)
						}),
					)
				} else {
					yield* Effect.logWarning(
						`portless could not register https://${hostname}.localhost; ${news.name} is only reachable on 127.0.0.1:${port}`,
					)
				}
				return {
					name: news.name,
					hostname,
					host: "127.0.0.1",
					port,
					url: aliased ? `https://${hostname}.localhost` : `http://127.0.0.1:${port}`,
					aliased,
				} satisfies RouteAttributes
			}),
		} satisfies LocalProvider.LocalProviderSpec<Route>),
	)

/** Register both providers; merge into the stack's `providers` layer. */
export const providers = () =>
	ProviderLayer.dual(Route, { live: RouteProviderLive, local: RouteProviderLocal })
