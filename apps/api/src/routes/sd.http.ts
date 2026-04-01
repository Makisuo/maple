import { timingSafeEqual } from "node:crypto"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import {
  MapleApi,
  PrometheusSDTarget,
  SDPersistenceError,
  SDUnauthorizedError,
} from "@maple/domain/http"
import { Array as Arr, Effect, Option, Redacted } from "effect"
import { Env } from "../services/Env"
import { ScrapeTargetsService } from "../services/ScrapeTargetsService"

export const HttpServiceDiscoveryLive = HttpApiBuilder.group(
  MapleApi,
  "serviceDiscovery",
  (handlers) =>
    Effect.gen(function* () {
      const env = yield* Env
      const service = yield* ScrapeTargetsService

      return handlers.handle("prometheus", () =>
        Effect.gen(function* () {
          const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
            onNone: () => undefined,
            onSome: Redacted.value,
          })

          if (!internalToken) {
            return yield* Effect.fail(
              new SDUnauthorizedError({ message: "Service discovery endpoint not configured" }),
            )
          }

          const req = yield* HttpServerRequest.HttpServerRequest
          const authHeader = req.headers.authorization ?? ""
          const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""

          const isValid =
            provided.length === internalToken.length &&
            timingSafeEqual(Buffer.from(provided), Buffer.from(internalToken))

          if (!isValid) {
            return yield* Effect.fail(
              new SDUnauthorizedError({ message: "Unauthorized" }),
            )
          }

          const rows = yield* service.listAllEnabled().pipe(
            Effect.mapError(
              (e) => new SDPersistenceError({ message: e.message }),
            ),
          )

          const sdTargets = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const url = yield* Effect.try({
                try: () => new URL(row.url),
                catch: () => new Error("Invalid URL"),
              }).pipe(
                Effect.option,
              )

              if (Option.isNone(url)) {
                yield* Effect.logWarning("Skipping scrape target with invalid URL").pipe(
                  Effect.annotateLogs({
                    scrapeTargetId: row.id,
                    url: row.url,
                  }),
                )
                return Option.none<PrometheusSDTarget>()
              }

              const labels: Record<string, string> = {
                __scheme__: url.value.protocol.replace(":", ""),
                __metrics_path__: url.value.pathname,
                __scrape_interval__: `${row.scrapeIntervalSeconds}s`,
                job: row.serviceName ?? row.name,
                maple_org_id: row.orgId,
                maple_scrape_target_id: row.id,
                maple_scrape_target_name: row.name,
              }

              if (row.labelsJson) {
                const labelsJson = row.labelsJson
                const extra = yield* Effect.try({
                  try: () => JSON.parse(labelsJson) as unknown,
                  catch: () => new Error("Invalid JSON"),
                }).pipe(Effect.option)

                if (Option.isSome(extra) && extra.value && typeof extra.value === "object") {
                  for (const [k, v] of Object.entries(extra.value)) {
                    if (typeof v === "string") {
                      labels[k] = v
                    }
                  }
                }
              }

              return Option.some(new PrometheusSDTarget({ targets: [url.value.host], labels }))
            }),
          ).pipe(Effect.map(Arr.getSomes))

          return sdTargets
        }),
      )
    }),
)
