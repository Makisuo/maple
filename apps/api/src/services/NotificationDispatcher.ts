import type { AlertDestinationRow } from "@maple/db"
import { alertDestinations } from "@maple/db"
import {
  type AlertComparator,
  type AlertDestinationId,
  type AlertEventType,
  type AlertSeverity,
  type AlertSignalType,
  type OrgId,
} from "@maple/domain/http"
import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import {
  dispatchDelivery as dispatchDeliveryImpl,
  type DispatchContext,
} from "./AlertDeliveryDispatch"
import { decryptAes256Gcm, parseBase64Aes256GcmKey } from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

/*
 * Shared notification dispatch for alert-adjacent features (error issues /
 * incidents). Mirrors the minimal slice of AlertsService we need: load
 * destinations by id, decrypt secrets, dispatch a single synchronous event.
 *
 * Failures are logged and swallowed — the caller must remain a best-effort
 * side channel. A dedicated delivery-event table / retry queue can be
 * layered on later.
 */

const DestinationSecretConfigSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("slack"),
    webhookUrl: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("pagerduty"),
    integrationKey: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    url: Schema.String,
    signingSecret: Schema.NullOr(Schema.String),
  }),
])

const DestinationPublicConfigSchema = Schema.Struct({
  summary: Schema.String,
  channelLabel: Schema.NullOr(Schema.String),
})

const SecretConfigFromJson = Schema.fromJsonString(DestinationSecretConfigSchema)
const PublicConfigFromJson = Schema.fromJsonString(DestinationPublicConfigSchema)

const DELIVERY_TIMEOUT_MS = 15_000

export interface NotificationRequest {
  readonly deliveryKey: string
  readonly ruleId: string
  readonly ruleName: string
  readonly groupKey: string | null
  readonly signalType: AlertSignalType
  readonly severity: AlertSeverity
  readonly comparator: AlertComparator
  readonly threshold: number
  readonly eventType: AlertEventType
  readonly incidentId: string | null
  readonly incidentStatus: string
  readonly dedupeKey: string
  readonly windowMinutes: number
  readonly value: number | null
  readonly sampleCount: number | null
  readonly linkUrl: string
}

export interface NotificationDispatcherShape {
  readonly dispatch: (
    orgId: OrgId,
    destinationIds: ReadonlyArray<AlertDestinationId>,
    context: NotificationRequest,
  ) => Effect.Effect<{ readonly delivered: number; readonly failed: number }>
}

export class NotificationDispatcher extends Context.Service<
  NotificationDispatcher,
  NotificationDispatcherShape
>()("NotificationDispatcher", {
  make: Effect.gen(function* () {
    const database = yield* Database
    const env = yield* Env

    const encryptionKey = yield* parseBase64Aes256GcmKey(
      Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
      (message) => new Error(message),
    )

    const hydrate = (row: AlertDestinationRow) =>
      Effect.gen(function* () {
        const publicConfig = yield* Schema.decodeUnknownEffect(PublicConfigFromJson)(
          row.configJson,
        )
        const secretJson = yield* decryptAes256Gcm(
          {
            ciphertext: row.secretCiphertext,
            iv: row.secretIv,
            tag: row.secretTag,
          },
          encryptionKey,
          () => new Error("Failed to decrypt destination secret"),
        )
        const secretConfig = yield* Schema.decodeUnknownEffect(SecretConfigFromJson)(
          secretJson,
        )
        return { publicConfig, secretConfig } as const
      })

    const dispatchOne = (row: AlertDestinationRow, request: NotificationRequest) =>
      Effect.gen(function* () {
        const hydrated = yield* hydrate(row)
        const context: DispatchContext = {
          destination: row,
          publicConfig: hydrated.publicConfig,
          secretConfig: hydrated.secretConfig,
          deliveryKey: request.deliveryKey,
          ruleId: request.ruleId,
          ruleName: request.ruleName,
          groupKey: request.groupKey,
          signalType: request.signalType,
          severity: request.severity,
          comparator: request.comparator,
          threshold: request.threshold,
          eventType: request.eventType,
          incidentId: request.incidentId,
          incidentStatus: request.incidentStatus,
          dedupeKey: request.dedupeKey,
          windowMinutes: request.windowMinutes,
          value: request.value,
          sampleCount: request.sampleCount,
        }
        const payloadJson = JSON.stringify({
          eventType: request.eventType,
          incidentId: request.incidentId,
          incidentStatus: request.incidentStatus,
          dedupeKey: request.dedupeKey,
          rule: {
            id: request.ruleId,
            name: request.ruleName,
            signalType: request.signalType,
            severity: request.severity,
            groupKey: request.groupKey,
            comparator: request.comparator,
            threshold: request.threshold,
            windowMinutes: request.windowMinutes,
          },
          observed: {
            value: request.value,
            sampleCount: request.sampleCount,
          },
          linkUrl: request.linkUrl,
          sentAt: new Date().toISOString(),
        })
        return yield* dispatchDeliveryImpl(
          context,
          payloadJson,
          globalThis.fetch,
          DELIVERY_TIMEOUT_MS,
          request.linkUrl,
        )
      })

    const dispatch: NotificationDispatcherShape["dispatch"] = (
      orgId,
      destinationIds,
      context,
    ) =>
      Effect.gen(function* () {
        if (destinationIds.length === 0) return { delivered: 0, failed: 0 }

        const rows = yield* database
          .execute((db) =>
            db
              .select()
              .from(alertDestinations)
              .where(
                and(
                  eq(alertDestinations.orgId, orgId),
                  inArray(alertDestinations.id, destinationIds as ReadonlyArray<string>),
                ),
              ),
          )
          .pipe(
            Effect.tapError((error) =>
              Effect.logError("NotificationDispatcher: failed to load destinations").pipe(
                Effect.annotateLogs({ orgId, message: error.message }),
              ),
            ),
            Effect.catch(() => Effect.succeed([] as Array<AlertDestinationRow>)),
          )

        const enabled = rows.filter((row) => row.enabled === 1)

        const results = yield* Effect.forEach(
          enabled,
          (row: AlertDestinationRow) =>
            dispatchOne(row, context).pipe(
              Effect.map(() => "delivered" as const),
              Effect.tapError((error) =>
                Effect.logError(
                  "NotificationDispatcher: delivery failed",
                ).pipe(
                  Effect.annotateLogs({
                    orgId,
                    destinationId: row.id,
                    destinationType: row.type,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                ),
              ),
              Effect.catch(() => Effect.succeed("failed" as const)),
            ),
          { concurrency: "unbounded" },
        )

        return {
          delivered: results.filter((r) => r === "delivered").length,
          failed: results.filter((r) => r === "failed").length,
        }
      })

    return { dispatch } satisfies NotificationDispatcherShape
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer
}
