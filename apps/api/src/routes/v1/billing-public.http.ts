import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Effect, Option, Schema } from "effect"
import { CatalogPlan, CatalogPlansResponse, MapleApi } from "@maple/domain/http"
import { decodeUpstream, ensureOk } from "@/services/billing/autumn-client"
import { AutumnClient } from "@/services/billing/autumn-http"
import { AuthService } from "@/services/auth/AuthService"

// The plan catalog is the one billing operation that is NOT internal-only: it is
// served unauthenticated so a transient token-settle gap renders prices instead
// of a 401. Everything else moved to `/internal/billing` behind session auth.

export const HttpBillingPublicLive = HttpApiBuilder.group(MapleApi, "billingPublic", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
		const autumn = yield* AutumnClient

		return handlers.handle("listPlans", () =>
			Effect.gen(function* () {
				// Public route: resolve the tenant optionally so an onboarding token gap
				// still serves the catalog, while authed callers get per-customer
				// `customerEligibility` (autumn marks listPlans' customerId optional).
				const req = yield* HttpServerRequest.HttpServerRequest
				const tenant = yield* Effect.option(auth.resolveTenant(req.headers as Record<string, string>))
				const customerId = Option.getOrUndefined(tenant)?.orgId
				const result = yield* autumn.listPlans(customerId)
				const response = yield* ensureOk(result)
				// Autumn wraps the catalog as `{ list: [...] }`.
				const list = (response as { list?: unknown })?.list ?? response
				const plans = yield* decodeUpstream(Schema.Array(CatalogPlan), list)
				return new CatalogPlansResponse({ plans })
			}),
		)
	}),
)
