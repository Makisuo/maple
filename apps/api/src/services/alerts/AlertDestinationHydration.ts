import type { AlertDestinationRow } from "@maple/db"
import { Effect, Schema } from "effect"
import { decryptAes256Gcm } from "@/platform/Crypto"

/**
 * `alert_destinations.config_json` is a jsonb column, so the driver hands back
 * an already-parsed object — decode it directly. (The secret config below is a
 * genuine JSON *string*, produced by decrypting `secret_ciphertext`, so it
 * still goes through `fromJsonString`.)
 */
export const DestinationPublicConfigSchema = Schema.Struct({
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
		type: Schema.Literal("slack-bot"),
		// No secret token here — the bot token is resolved from the org's
		// slack_workspaces row at dispatch time. Only the target channel is stored.
		channelId: Schema.String,
		channelName: Schema.NullOr(Schema.String),
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

export const SecretConfigFromJson = Schema.fromJsonString(DestinationSecretConfigSchema)

export interface HydratedDestination {
	readonly publicConfig: DestinationPublicConfig
	readonly secretConfig: DestinationSecretConfig
}

const parsePublicConfig = <E>(
	row: AlertDestinationRow,
	onError: (cause: unknown) => E,
): Effect.Effect<DestinationPublicConfig, E> =>
	Schema.decodeUnknownEffect(DestinationPublicConfigSchema)(row.configJson).pipe(Effect.mapError(onError))

const parseSecretConfig = <E>(
	json: string,
	onError: (cause: unknown) => E,
): Effect.Effect<DestinationSecretConfig, E> =>
	Schema.decodeUnknownEffect(SecretConfigFromJson)(json).pipe(Effect.mapError(onError))

export const hydrateDestinationRow = <E>(
	row: AlertDestinationRow,
	encryptionKey: Buffer,
	errors: {
		onPublicConfigInvalid: (cause: unknown) => E
		onDecryptFailure: () => E
		onSecretConfigInvalid: (cause: unknown) => E
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
