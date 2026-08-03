import { Schema } from "effect"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import { MapleApi } from "./MapleApi"
import type { Providers } from "./Providers"

/**
 * The org's telemetry ingest keys — a per-organization **singleton** the API
 * creates lazily on first access. This resource only observes it (making the
 * keys available as outputs); rolling is deliberately not modeled yet since
 * a roll immediately invalidates the previous key for all senders.
 */
export interface IngestKeysProps {}

export type IngestKeys = Resource<
	"Maple.IngestKeys",
	IngestKeysProps,
	{
		/** The `maple_pk_…` public ingest key (safe for client-side senders). */
		publicKey: Redacted.Redacted<string>
		/** The `maple_sk_…` private ingest key (server-side senders only). */
		privateKey: Redacted.Redacted<string>
		publicRotatedAt: string
		privateRotatedAt: string
	},
	never,
	Providers
>

/**
 * Your organization's ingest credentials, surfaced as resource outputs so
 * they can flow into other resources (e.g. a Worker's env).
 *
 * @example
 * ```typescript
 * const ingest = yield* Maple.IngestKeys("ingest")
 * // ingest.publicKey / ingest.privateKey are Redacted<string> outputs.
 * ```
 */
export const IngestKeys = Resource<IngestKeys>("Maple.IngestKeys")

const WireIngestKeys = Schema.Struct({
	public_key: Schema.String,
	private_key: Schema.String,
	public_rotated_at: Schema.String,
	private_rotated_at: Schema.String,
})
const decodeWireIngestKeys = Schema.decodeUnknownEffect(WireIngestKeys)

const toAttributes = (wire: Schema.Schema.Type<typeof WireIngestKeys>) => ({
	publicKey: Redacted.make(wire.public_key),
	privateKey: Redacted.make(wire.private_key),
	publicRotatedAt: wire.public_rotated_at,
	privateRotatedAt: wire.private_rotated_at,
})

export const IngestKeysProvider = () =>
	Provider.effect(
		IngestKeys,
		Effect.gen(function* () {
			const api = yield* MapleApi
			const fetchKeys = Effect.gen(function* () {
				const fetched = yield* api.get("/v2/ingest_keys")
				return toAttributes(yield* decodeWireIngestKeys(fetched))
			})
			return {
				// Always-present org configuration: deleting the resource only stops
				// tracking it, and nuke skips it entirely.
				nuke: { singleton: true },
				reconcile: () => fetchKeys,
				delete: () => Effect.void,
				read: () => fetchKeys,
				list: () => Effect.map(fetchKeys, (attributes) => [attributes]),
			}
		}),
	)
