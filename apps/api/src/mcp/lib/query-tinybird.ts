import { HttpServerRequest } from "@effect/platform"
import type { TinybirdPipe } from "@maple/domain"
import { Effect, ManagedRuntime } from "effect"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { TinybirdService } from "@/services/TinybirdService"

const TinybirdRuntime = ManagedRuntime.make(TinybirdService.Default)

const resolveTenant = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const nativeReq = yield* HttpServerRequest.toWeb(req)
  return yield* Effect.tryPromise(() => resolveMcpTenantContext(nativeReq))
}).pipe(Effect.orDie)

export const queryTinybird = <T = any>(
  pipe: TinybirdPipe,
  params?: Record<string, unknown>,
): Effect.Effect<{ data: T[] }, never, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const tenant = yield* resolveTenant

    const response = yield* Effect.tryPromise(() =>
      TinybirdRuntime.runPromise(TinybirdService.query(tenant, { pipe, params })),
    ).pipe(Effect.orDie)

    return { data: response.data as T[] }
  })
