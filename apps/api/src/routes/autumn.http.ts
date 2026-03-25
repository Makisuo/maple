import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted } from "effect"
import { autumnHandler } from "autumn-js/backend"
import { Env } from "../services/Env"
import { AuthService } from "../services/AuthService"

export const AutumnRouter = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const env = yield* Env
    const authService = yield* AuthService
    const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
      onNone: () => undefined,
      onSome: (value) => Redacted.value(value),
    })
    if (!secretKey) return

    const handle = (req: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const tenant = yield* authService.resolveTenant(
          req.headers as Record<string, string>,
        )

        const body = yield* req.json

        const result = yield* Effect.tryPromise(() =>
          autumnHandler({
            request: { url: req.url, method: req.method, body },
            customerId: tenant.orgId,
            clientOptions: { secretKey },
          }),
        )

        return yield* HttpServerResponse.json(result.response, {
          status: result.statusCode,
        })
      })

    const routes = [
      "getOrCreateCustomer",
      "attach",
      "previewAttach",
      "updateSubscription",
      "previewUpdateSubscription",
      "openCustomerPortal",
      "createReferralCode",
      "redeemReferralCode",
      "multiAttach",
      "previewMultiAttach",
      "setupPayment",
      "listPlans",
      "listEvents",
      "aggregateEvents",
    ] as const

    for (const route of routes) {
      yield* router.add("POST", `/api/autumn/${route}`, handle)
    }
  }),
)
