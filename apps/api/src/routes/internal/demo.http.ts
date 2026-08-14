import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { DemoService } from "@/services/org/DemoService"

export const HttpDemoLive = HttpApiBuilder.group(MapleInternalApi, "demo", (handlers) =>
	Effect.gen(function* () {
		const demo = yield* DemoService

		return handlers.handle("seed", ({ payload }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				return yield* demo.seed(tenant, payload.hours ?? 6)
			}),
		)
	}),
)
