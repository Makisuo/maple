import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import type { VcsInstallation } from "@maple/domain/http"
import { Env } from "@/platform/Env"
import { GithubAppClient } from "@/services/integrations/vcs/vendor/github/GithubAppClient"
import { GithubHttp, type GithubHttpApi } from "@/services/integrations/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "@/services/integrations/vcs/vendor/github/GithubProvider"

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const env = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				PORT: "3482",
				TINYBIRD_HOST: "https://api.tinybird.co",
				TINYBIRD_TOKEN: "test-token",
				MAPLE_AUTH_MODE: "self_hosted",
				MAPLE_ROOT_PASSWORD: "test-root-password",
				MAPLE_DEFAULT_ORG_ID: "default",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
				GITHUB_APP_ID: "123456",
				GITHUB_APP_PRIVATE_KEY: privateKey,
			}),
		),
	),
)

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const tokenResponse = () =>
	jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" })

const INSTALLATION = { externalInstallationId: "42" } as VcsInstallation
const REPO = { externalRepoId: "1", owner: "octo", name: "shop" }

const apiPullRequest = (overrides: Record<string, unknown> = {}) => ({
	number: 612,
	title: "Guard the null customer id",
	html_url: "https://github.com/octo/shop/pull/612",
	state: "open",
	draft: false,
	updated_at: "2026-08-20T10:00:00Z",
	merged_at: null,
	merge_commit_sha: null,
	user: { login: "octocat", avatar_url: "https://avatars.example/octocat" },
	head: { ref: "fix/null-customer" },
	base: { ref: "main" },
	...overrides,
})

const providerLayer = (responses: ReadonlyArray<Response>, requests: Array<string> = []) => {
	let next = 0
	const http = Layer.succeed(GithubHttp, {
		fetch: async (url) => {
			requests.push(url)
			return responses[next++]!
		},
	} satisfies GithubHttpApi)
	return GithubProvider.layer.pipe(
		Layer.provide(GithubAppClient.layer.pipe(Layer.provide(http), Layer.provide(env))),
		Layer.provide(env),
	)
}

describe("GithubProvider pull requests", () => {
	it.effect("lists one page, newest-updated first, and normalizes each state", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				jsonResponse([
					apiPullRequest(),
					// Merged: GitHub reports `state: "closed"` and only `merged_at`
					// separates it from a PR closed without merging.
					apiPullRequest({
						number: 611,
						state: "closed",
						merged_at: "2026-08-19T09:00:00Z",
						merge_commit_sha: "a".repeat(40),
					}),
					apiPullRequest({ number: 610, state: "closed", draft: true, user: null }),
				]),
			],
			requests,
		)

		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const prs = yield* provider.fetchPullRequests(INSTALLATION, REPO, { limit: 50 })

			assert.deepStrictEqual(
				prs.map((pr) => [pr.number, pr.state]),
				[
					[612, "open"],
					[611, "merged"],
					[610, "closed"],
				],
			)
			assert.strictEqual(prs[1]?.mergedAtMs, Date.parse("2026-08-19T09:00:00Z"))
			assert.strictEqual(prs[1]?.mergeCommitSha, "a".repeat(40))
			assert.strictEqual(prs[0]?.authorLogin, "octocat")
			assert.strictEqual(prs[2]?.authorLogin, null, "a ghosted author is not a failure")
			assert.strictEqual(prs[2]?.isDraft, true)
			assert.strictEqual(prs[0]?.headRef, "fix/null-customer")

			const listUrl = requests[1]!
			assert.match(listUrl, /\/repos\/octo\/shop\/pulls\?/)
			assert.match(listUrl, /state=all/)
			assert.match(listUrl, /sort=updated/)
			assert.match(listUrl, /direction=desc/)
			// One page only — a picker must not spend an installation's rate budget
			// walking a repository's whole pull-request history.
			assert.strictEqual(requests.length, 2)
		}).pipe(Effect.provide(layer))
	})

	it.effect("caps the requested page at one provider page", () =>
		Effect.gen(function* () {
			const requests: Array<string> = []
			const layer = providerLayer([tokenResponse(), jsonResponse([])], requests)
			yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				yield* provider.fetchPullRequests(INSTALLATION, REPO, { limit: 5_000 })
				assert.match(requests[1]!, /per_page=100/)
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("fetches one pull request by number", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[tokenResponse(), jsonResponse(apiPullRequest({ state: "closed", merged_at: null }))],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const pr = yield* provider.fetchPullRequest(INSTALLATION, REPO, 612)
			assert.isTrue(Option.isSome(pr))
			assert.strictEqual(Option.getOrThrow(pr).state, "closed")
			assert.match(requests[1]!, /\/repos\/octo\/shop\/pulls\/612$/)
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers none for a pull request number that does not exist", () =>
		// Someone mistyped, or pasted a URL for another repository. Routine, not a
		// provider failure — the caller keeps going with an unenriched link.
		Effect.gen(function* () {
			const layer = providerLayer([
				tokenResponse(),
				jsonResponse({ message: "Not Found" }, 404),
			])
			yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				const pr = yield* provider.fetchPullRequest(INSTALLATION, REPO, 99_999)
				assert.isTrue(Option.isNone(pr))
			}).pipe(Effect.provide(layer))
		}),
	)
})
