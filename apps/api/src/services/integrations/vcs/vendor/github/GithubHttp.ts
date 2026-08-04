import { Context, Effect, Layer } from "effect"

// ---------------------------------------------------------------------------
// Thin seam over the platform `fetch`, so the GitHub client's rate-limit and
// pagination handling can be unit-tested by injecting canned responses. The
// default layer is the global `fetch`; tests provide a stub via Layer.succeed.
// ---------------------------------------------------------------------------

export interface GithubHttpShape {
	readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
}

export class GithubHttp extends Context.Service<GithubHttp, GithubHttpShape>()(
	"@maple/api/services/vcs/vendor/github/GithubHttp",
	{
		make: Effect.sync((): GithubHttpShape => ({ fetch: (url, init) => fetch(url, init) })),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
