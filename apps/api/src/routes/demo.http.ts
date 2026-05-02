import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { DemoService } from "../services/DemoService"

export const HttpDemoLive = HttpApiBuilder.group(MapleApi, "demo", (handlers) =>
	Effect.gen(function* () {
		const demo = yield* DemoService

		return handlers.handle("seed", ({ payload }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				return yield* demo.seed(tenant.orgId, tenant.userId, payload.hours ?? 6)
			}),
		)
	}),
)
