import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AiTriageForbiddenError, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AiTriageService } from "@/services/errors/AiTriageService"
import { requireAdmin } from "@/services/auth/auth"

export const HttpAiTriageLive = HttpApiBuilder.group(MapleInternalApi, "aiTriage", (handlers) =>
	Effect.gen(function* () {
		const triage = yield* AiTriageService

		return handlers
			.handle("getSettings", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* triage.getSettings(tenant.orgId)
				}).pipe(Effect.withSpan("HttpAiTriage.getSettings")),
			)
			.handle("updateSettings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					yield* requireAdmin(
						tenant.roles,
						() =>
							new AiTriageForbiddenError({
								message: "Only org admins can manage AI triage settings",
							}),
					)
					return yield* triage.updateSettings(tenant.orgId, tenant.userId, payload)
				}).pipe(Effect.withSpan("HttpAiTriage.updateSettings")),
			)
	}),
)
