import type { TenantContext } from "@maple/auth"
import { OrgId, UnauthorizedError, UserId } from "@maple/domain/http"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { TenantResolver, type TenantResolverShape } from "./auth/TenantResolver"
import {
	ElectricClient,
	type ElectricClientShape,
	type ElectricUpstreamResponse,
} from "./electric/ElectricClient"
import { SyncConfig, type SyncConfigShape } from "./config"
import type { ShapeRequest } from "./shapes/request"

/** A coherent self-hosted config; override only what a test is actually about. */
export const syncConfig = (overrides: Partial<SyncConfigShape> = {}): SyncConfigShape => ({
	ELECTRIC_URL: Option.some("http://electric:3000"),
	ELECTRIC_SOURCE_ID: Option.none(),
	ELECTRIC_SECRET: Option.none(),
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_ORG_ID_OVERRIDE: Option.none(),
	MAPLE_ROOT_PASSWORD: Option.some(Redacted.make("test-root-password")),
	CLERK_SECRET_KEY: Option.none(),
	CLERK_PUBLISHABLE_KEY: Option.none(),
	CLERK_JWT_KEY: Option.none(),
	...overrides,
})

export const syncConfigLayer = (overrides: Partial<SyncConfigShape> = {}) =>
	Layer.succeed(SyncConfig, SyncConfig.of(syncConfig(overrides)))

export interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
	body: string | null
}

/**
 * The repo's outbound-HTTP stub (see `apps/scraper/src/ApiClient.test.ts`):
 * records what was sent and returns a canned `Response`, so assertions are made
 * on the real upstream request rather than on a mock's call log.
 */
export const stubFetch = (
	recorded: Array<RecordedRequest>,
	respond: (url: string) => Response,
): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		recorded.push({
			url,
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? init.body : null,
		})
		return respond(url)
	}) as typeof globalThis.fetch

/** A resolver that always authenticates, as `orgId`. */
export const fixedTenantLayer = (orgId: string) => {
	const tenant: TenantContext = {
		orgId: Schema.decodeUnknownSync(OrgId)(orgId),
		userId: Schema.decodeUnknownSync(UserId)("user_test"),
		roles: [],
		authMode: "self_hosted",
	}
	return Layer.succeed(TenantResolver, {
		resolve: () => Effect.succeed(tenant),
	} satisfies TenantResolverShape)
}

/** A resolver that always rejects, as an expired/absent session would. */
export const noTenantLayer = Layer.succeed(TenantResolver, {
	resolve: () => Effect.fail(new UnauthorizedError({ message: "no session" })),
} satisfies TenantResolverShape)

export interface ElectricCall {
	readonly request: ShapeRequest
	readonly orgId: string
}

/**
 * An `ElectricClient` that records its calls and replays a scripted outcome.
 * This is the seam that makes the handler's own behaviour testable: what reaches
 * Electric (crucially, *which org*) is observable without an upstream at all.
 */
export const recordingElectricClient = (options: {
	readonly calls: Array<ElectricCall>
	readonly respond: () => ReturnType<ElectricClientShape["fetchShape"]>
	readonly ensureConfigured?: ElectricClientShape["ensureConfigured"]
}) =>
	Layer.succeed(ElectricClient, {
		ensureConfigured: options.ensureConfigured ?? Effect.void,
		fetchShape: (request, orgId) => {
			options.calls.push({ request, orgId })
			return options.respond()
		},
	} satisfies ElectricClientShape)

/** The common case: a canned 200 with the headers Electric would send. */
export const okUpstream = (overrides: Partial<ElectricUpstreamResponse> = {}): ElectricUpstreamResponse => ({
	status: 200,
	headers: { "content-type": "application/json", "electric-handle": "h1" },
	body: `[{"key":"row"}]`,
	...overrides,
})

/**
 * Drives the router the way the browser does: a real `Request` through the real
 * web handler, so routing, the span wrapper, and the error boundary all run.
 */
export const shapeRequest = <A, E>(
	layers: Layer.Layer<A, E, HttpRouter.HttpRouter>,
	path: string,
	init?: RequestInit,
) =>
	Effect.gen(function* () {
		const { handler, dispose } = HttpRouter.toWebHandler(layers, { disableLogger: true })
		const response = yield* Effect.promise(() =>
			handler(new Request(`http://sync.maple.test${path}`, init), Context.empty() as never),
		)
		const body = yield* Effect.promise(() => response.text())
		yield* Effect.promise(() => dispose())
		return { status: response.status, body, headers: response.headers }
	})
