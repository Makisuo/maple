/**
 * The Worker's runtime environment, as this app is allowed to see it.
 *
 * Structural on purpose, like the `HTMLRewriter` slice in `og/share-preview.ts`:
 * this app's tsconfig is a browser one (`lib: DOM`), and importing
 * `@cloudflare/workers-types` to describe two bindings would retype the entire
 * SPA. The other direction is checked instead — `alchemy.run.ts` asserts that
 * the env it deploys satisfies this type, under the tsconfig that *can* see the
 * Workers types (`tsconfig.alchemy.json`), so a drifted key or type fails CI
 * there rather than 404ing in production here.
 *
 * Everything except `ASSETS` is optional because absence is a real runtime
 * state, not a type error: this worker only exists on deployed stages (`bun
 * dev` serves the SPA through Vite, not through this worker), and a dev-stage
 * deploy without an api domain binds neither key.
 */
export interface WebWorkerEnv {
	readonly ASSETS: { fetch: (request: Request) => Promise<Response> }
	/**
	 * The API this deployment's pages talk to, for the share-preview lookups.
	 * Absent in a build that has not set it — every preview then falls back to
	 * the generic card, which is the same behaviour as before previews existed.
	 */
	readonly MAPLE_API_BASE_URL?: string
	/**
	 * Service binding to the api Worker. When present, share-preview traffic
	 * rides worker-to-worker instead of leaving Cloudflare and re-entering
	 * through the public domain.
	 */
	readonly API?: { fetch: (request: Request) => Promise<Response> }
}

/**
 * How this worker reaches the API: the base URL that names it (bindings still
 * address requests by absolute URL) and the fetch that carries them — the
 * service binding when bound, the global `fetch` when a deployment lacks it.
 */
export interface ApiTarget {
	readonly baseUrl: string
	readonly fetch: (request: Request) => Promise<Response>
}

/** No base URL means no API: previews degrade to the generic card. */
export const apiTarget = (env: WebWorkerEnv): ApiTarget | undefined => {
	const baseUrl = env.MAPLE_API_BASE_URL
	if (baseUrl === undefined || baseUrl === "") return undefined
	const api = env.API
	return { baseUrl, fetch: api === undefined ? fetch : (request) => api.fetch(request) }
}
