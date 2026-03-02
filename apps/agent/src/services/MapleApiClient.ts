import type { TinybirdPipe } from "@maple/domain/tinybird-pipes"
import * as Effect from "effect/Effect"
import { AgentEnv } from "./AgentEnv"

export class MapleApiClient extends Effect.Service<MapleApiClient>()("MapleApiClient", {
  accessors: true,
  dependencies: [AgentEnv.Default],
  effect: Effect.gen(function* () {
    const env = yield* AgentEnv

    const serviceToken = `maple_svc_${env.INTERNAL_SERVICE_TOKEN}`

    const queryTinybird = (orgId: string, pipe: TinybirdPipe, params: Record<string, unknown>) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${env.MAPLE_API_URL}/api/tinybird/query`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceToken}`,
              "X-Org-Id": orgId,
            },
            body: JSON.stringify({ pipe, params }),
          })
          if (!res.ok) {
            const body = await res.text()
            throw new Error(`API ${res.status}: ${body}`)
          }
          return (await res.json()) as { data: unknown[] }
        },
        catch: (cause) =>
          new Error(`Failed to query ${pipe}: ${cause instanceof Error ? cause.message : String(cause)}`),
      })

    return { queryTinybird }
  }),
}) {}
