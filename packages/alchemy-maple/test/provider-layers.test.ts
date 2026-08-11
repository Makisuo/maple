import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { Dashboard, type Dashboard as DashboardResource } from "../src/Dashboard"
import { MapleEnvironment } from "../src/MapleEnvironment"
import { Providers, providers, providersWithDependencies } from "../src/Providers"

const session: ScopedPlanStatusSession = {
	emit: () => Effect.void,
	done: () => Effect.void,
	note: () => Effect.void,
}

const wireDashboard = {
	id: "dash_override",
	object: "dashboard",
	name: "Override proof",
	description: null,
	tags: [],
	time_range: { type: "relative", value: "12h" },
	widgets: [],
	variables: [],
	created_at: "2026-08-11T12:00:00.000Z",
	updated_at: "2026-08-11T12:00:00.000Z",
}

describe("Maple provider layers", () => {
	it("uses the caller-supplied environment and HTTP client", async () => {
		const requests: Array<{ url: string; authorization: string | undefined }> = []
		const httpClient = HttpClient.make((request, url) => {
			requests.push({
				url: url.toString(),
				authorization: request.headers.authorization,
			})
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(JSON.stringify(wireDashboard), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				),
			)
		})

		const customProviders = providersWithDependencies().pipe(
			Layer.provide(
				Layer.succeed(MapleEnvironment, {
					baseUrl: "https://maple.override.test",
					apiKey: Redacted.make("maple_ak_override"),
				}),
			),
			Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
		)

		const attributes = await Effect.runPromise(
			Effect.gen(function* () {
				const collection = yield* Providers
				const provider = collection.get<DashboardResource>(Dashboard.Type)
				if (provider === undefined) return yield* Effect.die("Dashboard provider is missing")
				return yield* provider.reconcile({
					id: "override-proof",
					fqn: "test/override-proof",
					instanceId: "i-1",
					news: { name: "Override proof" },
					olds: undefined,
					output: undefined,
					session,
					bindings: [],
				})
			}).pipe(Effect.provide(customProviders)),
		)

		expect(attributes).toEqual({ dashboardId: "dash_override", name: "Override proof" })
		expect(requests).toEqual([
			{
				url: "https://maple.override.test/v2/dashboards",
				authorization: "Bearer maple_ak_override",
			},
		])
	})

	it("keeps providers() as a closed env-backed default", async () => {
		const defaultProviders = providers().pipe(
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						MAPLE_API_KEY: "maple_ak_default",
						MAPLE_API_URL: "https://api.default.test",
					}),
				),
			),
		)

		const providerTypes = await Effect.runPromise(
			Effect.gen(function* () {
				const collection = yield* Providers
				return Object.keys(collection.providers).sort()
			}).pipe(Effect.provide(defaultProviders)),
		)

		expect(providerTypes).toEqual([
			"Maple.AlertDestination",
			"Maple.AlertRule",
			"Maple.ApiKey",
			"Maple.Dashboard",
			"Maple.IngestKeys",
		])
	})
})
