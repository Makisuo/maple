import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { QueryBuilderService } from "../services/QueryBuilderService"
import { QueryEngineService } from "../services/QueryEngineService"

export const HttpQueryEngineLive = HttpApiBuilder.group(MapleApi, "queryEngine", (handlers) =>
  Effect.gen(function* () {
    const queryEngine = yield* QueryEngineService
    const queryBuilder = yield* QueryBuilderService

    return handlers.handle("execute", ({ payload }) =>
      Effect.gen(function* () {
        const tenant = yield* CurrentTenant.Context
        return yield* queryEngine.execute(tenant, payload)
      }),
    )
      .handle("builderMetadata", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          return yield* queryBuilder.metadata(tenant, payload)
        }),
      )
      .handle("builderFieldValues", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          return yield* queryBuilder.fieldValues(tenant, payload)
        }),
      )
      .handle("builderPlan", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          return yield* queryBuilder.plan(tenant, payload)
        }),
      )
      .handle("builderExecute", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          return yield* queryBuilder.execute(tenant, payload)
        }),
      )
  }),
)
