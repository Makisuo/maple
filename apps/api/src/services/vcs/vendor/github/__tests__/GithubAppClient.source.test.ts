import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Layer } from "effect"
import { Env } from "@/lib/Env"
import { GithubAppClient } from "@/services/vcs/vendor/github/GithubAppClient"
import { GithubHttp, type GithubHttpShape } from "@/services/vcs/vendor/github/GithubHttp"

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const env = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				PORT: "3472",
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

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

describe("GithubAppClient source access", () => {
	it.effect("searches code and reads a file with the installation token", () => {
		const requests: Array<{ url: string; init?: RequestInit }> = []
		const responses = [
			jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" }),
			jsonResponse({
				items: [
					{
						path: "src/checkout.ts",
						sha: "blob-sha",
						html_url: "https://github.com/octo/shop/blob/main/src/checkout.ts",
						text_matches: [{ fragment: "throw new Error('card declined')" }],
					},
				],
			}),
			jsonResponse({
				type: "file",
				path: "src/checkout.ts",
				sha: "blob-sha",
				size: 26,
				html_url: "https://github.com/octo/shop/blob/main/src/checkout.ts",
				encoding: "base64",
				content: Buffer.from("export const checkout = 1\n").toString("base64"),
			}),
		]
		let nextResponse = 0
		const http = Layer.succeed(GithubHttp, {
			fetch: async (url, init) => {
				requests.push({ url, ...(init ? { init } : {}) })
				return responses[nextResponse++]!
			},
		} satisfies GithubHttpShape)
		const layer = GithubAppClient.layer.pipe(Layer.provide(http), Layer.provide(env))

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const search = yield* client.searchCode("42", "octo", "shop", "card declined", "src", 5)
			assert.strictEqual(search.items[0]?.path, "src/checkout.ts")
			assert.strictEqual(
				search.items[0]?.text_matches?.[0]?.fragment,
				"throw new Error('card declined')",
			)

			const file = yield* client.getSourceFile("42", "octo", "shop", "src/checkout.ts", "main")
			assert.strictEqual(file.content, Buffer.from("export const checkout = 1\n").toString("base64"))
			assert.strictEqual(requests.length, 3, "the cached installation token should be reused")
			assert.match(requests[1]!.url, /\/search\/code\?/)
			assert.match(requests[1]!.url, /repo%3Aocto%2Fshop/)
			assert.strictEqual(
				(requests[1]!.init?.headers as Record<string, string>).accept,
				"application/vnd.github.text-match+json",
			)
			assert.match(requests[2]!.url, /\/repos\/octo\/shop\/contents\/src\/checkout\.ts\?ref=main/)
		}).pipe(Effect.provide(layer))
	})
})
