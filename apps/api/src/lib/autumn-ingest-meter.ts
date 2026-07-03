/**
 * Autumn usage metering for telemetry ingested OUTSIDE the ingest gateway.
 *
 * The Rust gateway (apps/ingest/src/autumn.rs) is the primary metering point: it reports
 * decoded payload GB per signal to Autumn for everything arriving via /v1/*. Rows the API
 * worker writes straight to the warehouse (`WarehouseQueryService.ingest`) never pass the
 * gateway, so every writer of NET-NEW customer telemetry must report its serialized bytes
 * here — otherwise that data is free. Same contract as the gateway: POST /v1/track with
 * `customer_id` = orgId and `value` = bytes / 1e9 (GB).
 *
 * Deliberately NOT metered (not net-new customer telemetry):
 * - ServiceMapRollupService hourly edges — derived from spans already billed on arrival.
 * - AlertsService `alert_checks` — internal bookkeeping rows.
 * - DemoService seed data — Maple-injected onboarding samples.
 */
import { Cause, Effect, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { EnvShape } from "./Env"

export type BillableSignal = "logs" | "traces" | "metrics"

const encoder = new TextEncoder()

/** Serialized NDJSON byte size of the rows — the analog of the gateway's decoded payload bytes. */
export const ingestRowBytes = (rows: ReadonlyArray<unknown>): number =>
	rows.reduce((total: number, row) => total + encoder.encode(JSON.stringify(row)).length + 1, 0)

export interface TrackIngestOptions {
	readonly orgId: string
	readonly signal: BillableSignal
	readonly bytes: number
	/** Stable per-logical-usage key so a retried report can't double-bill. */
	readonly idempotencyKey: string
}

/**
 * Report ingested bytes to Autumn. Never fails: metering must not break ingestion, so
 * transport errors and non-2xx responses are logged and swallowed (mirroring the gateway's
 * fire-and-forget tracker). No-op when AUTUMN_SECRET_KEY is unset (self-hosted) or for the
 * default org.
 */
export const trackIngestUsage = (env: EnvShape, options: TrackIngestOptions): Effect.Effect<void> =>
	Option.match(env.AUTUMN_SECRET_KEY, {
		onNone: () => Effect.void,
		onSome: (secretKey) => {
			if (options.bytes <= 0 || options.orgId === env.MAPLE_DEFAULT_ORG_ID) return Effect.void
			return Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const request = HttpClientRequest.post(`${env.AUTUMN_API_URL}/v1/track`, {
					headers: { authorization: `Bearer ${Redacted.value(secretKey)}` },
				}).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						customer_id: options.orgId,
						feature_id: options.signal,
						value: options.bytes / 1_000_000_000,
						idempotency_key: options.idempotencyKey,
					}),
				)
				const response = yield* client.execute(request)
				if (response.status >= 300) {
					yield* Effect.logWarning("autumn ingest-usage track failed", {
						status: response.status,
						signal: options.signal,
						orgId: options.orgId,
					})
				}
			}).pipe(
				Effect.provide(FetchHttpClient.layer),
				Effect.timeout(5000),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("autumn ingest-usage track failed", {
								signal: options.signal,
								orgId: options.orgId,
								error: Cause.pretty(cause),
							}),
				),
			)
		},
	})
