import type { AlertDestinationRow } from "@maple/db"
import { Effect, Schema } from "effect"
import { decryptAes256Gcm } from "../lib/Crypto"

const DestinationPublicConfigSchema = Schema.Struct({
	summary: Schema.String,
	channelLabel: Schema.NullOr(Schema.String),
	hazelOrganizationId: Schema.optionalKey(Schema.String),
	hazelOrganizationName: Schema.optionalKey(Schema.String),
	hazelOrganizationLogoUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
	hazelChannelId: Schema.optionalKey(Schema.String),
	hazelChannelName: Schema.optionalKey(Schema.String),
	memberUserIds: Schema.optionalKey(Schema.Array(Schema.String)),
})

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
	Schema.Struct({
		type: Schema.Literal("hazel"),
		webhookUrl: Schema.String,
		signingSecret: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("hazel-oauth"),
		hazelOrganizationId: Schema.String,
		hazelOrganizationName: Schema.String,
		hazelChannelId: Schema.String,
		hazelChannelName: Schema.String,
		webhookId: Schema.String,
		webhookUrl: Schema.String,
		webhookToken: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("discord"),
		webhookUrl: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("email"),
		// Snapshot of the selected workspace members, resolved from the auth
		// provider at save time.
		members: Schema.Array(
			Schema.Struct({
				userId: Schema.String,
				email: Schema.String,
				name: Schema.optionalKey(Schema.NullOr(Schema.String)),
			}),
		),
	}),
])

export type DestinationPublicConfig = Schema.Schema.Type<typeof DestinationPublicConfigSchema>
export type DestinationSecretConfig = Schema.Schema.Type<typeof DestinationSecretConfigSchema>

export type EnrichedDestinationSecretConfig = DestinationSecretConfig

export const PublicConfigFromJson = Schema.fromJsonString(DestinationPublicConfigSchema)
export const SecretConfigFromJson = Schema.fromJsonString(DestinationSecretConfigSchema)

export interface HydratedDestination {
	readonly publicConfig: DestinationPublicConfig
	readonly secretConfig: DestinationSecretConfig
}

const parsePublicConfig = <E>(
	row: AlertDestinationRow,
	onError: () => E,
): Effect.Effect<DestinationPublicConfig, E> =>
	Schema.decodeUnknownEffect(PublicConfigFromJson)(row.configJson).pipe(Effect.mapError(onError))

const parseSecretConfig = <E>(json: string, onError: () => E): Effect.Effect<DestinationSecretConfig, E> =>
	Schema.decodeUnknownEffect(SecretConfigFromJson)(json).pipe(Effect.mapError(onError))

export const hydrateDestinationRow = <E>(
	row: AlertDestinationRow,
	encryptionKey: Buffer,
	errors: {
		onPublicConfigInvalid: () => E
		onDecryptFailure: () => E
		onSecretConfigInvalid: () => E
	},
): Effect.Effect<HydratedDestination, E> =>
	Effect.gen(function* () {
		const publicConfig = yield* parsePublicConfig(row, errors.onPublicConfigInvalid)
		const secretJson = yield* decryptAes256Gcm(
			{
				ciphertext: row.secretCiphertext,
				iv: row.secretIv,
				tag: row.secretTag,
			},
			encryptionKey,
			errors.onDecryptFailure,
		)
		const secretConfig = yield* parseSecretConfig(secretJson, errors.onSecretConfigInvalid)
		return { publicConfig, secretConfig }
	})
