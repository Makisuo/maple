import type { TinybirdPipe } from "@maple/domain"
import { Effect, ManagedRuntime } from "effect"
import { getTenantContext } from "@/lib/tenant-context"
import { TinybirdService } from "@/services/TinybirdService"

const TinybirdRuntime = ManagedRuntime.make(TinybirdService.Default)

export const queryTinybird = <T = any>(
  pipe: TinybirdPipe,
  params?: Record<string, unknown>,
): Effect.Effect<{ data: T[] }> =>
  Effect.gen(function* () {
    const tenant = getTenantContext()
    if (!tenant) return yield* Effect.die(new Error("Tenant context is missing for this request"))

    const response = yield* Effect.tryPromise(() =>
      TinybirdRuntime.runPromise(TinybirdService.query(tenant, { pipe, params })),
    ).pipe(Effect.orDie)

    return { data: response.data as T[] }
  })
