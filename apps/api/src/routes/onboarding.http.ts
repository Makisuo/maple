import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OnboardingService } from "../services/OnboardingService"

export const HttpOnboardingLive = HttpApiBuilder.group(MapleApi, "onboarding", (handlers) =>
	Effect.gen(function* () {
		const onboarding = yield* OnboardingService

		return handlers
			.handle("getState", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* onboarding.getState(tenant.orgId, tenant.userId)
				}),
			)
			.handle("updateState", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* onboarding.updateState(tenant.orgId, tenant.userId, undefined, {
						role: payload.role,
						demoDataRequested: payload.demoDataRequested,
						markOnboardingComplete: payload.markOnboardingComplete,
						markChecklistDismissed: payload.markChecklistDismissed,
					})
				}),
			)
	}),
)
