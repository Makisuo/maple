import {
	ScrapeTargetAuthError,
	ScrapeTargetEncryptionError,
	ScrapeTargetPersistenceError,
	type IntegrationsNotConnectedError,
	type IntegrationsPersistenceError,
	type IntegrationsRevokedError,
	type IntegrationsUpstreamError,
	type IntegrationsValidationError,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { decryptAes256Gcm } from "./Crypto"

/**
 * Credential shapes and Authorization-header construction shared by
 * ScrapeTargetsService (proxy scrapes, probes) and
 * PlanetScaleDiscoveryService (http_sd discovery calls).
 */

export const BearerCredentialsSchema = Schema.Struct({
	token: Schema.String,
})

export const BasicCredentialsSchema = Schema.Struct({
	username: Schema.String,
	password: Schema.String,
})

/**
 * PlanetScale-style service-token scheme: `Authorization: token {ID}:{SECRET}`.
 */
export const TokenCredentialsSchema = Schema.Struct({
	tokenId: Schema.String,
	tokenSecret: Schema.String,
})

export interface ScrapeAuthRowLike {
	readonly authType: string
	readonly authCredentialsCiphertext: string | null
	readonly authCredentialsIv: string | null
	readonly authCredentialsTag: string | null
}

const toEncryptionError = (message: string) => new ScrapeTargetEncryptionError({ message })

/**
 * `Effect.catchTags` handler set mapping a PlanetScale OAuth token-resolution
 * failure onto the scrape error taxonomy without losing the failure class: a
 * revoked or never-connected grant must stay distinguishable from a transient
 * upstream blip — a collapsed tag is how a dead grant goes invisible on the
 * error dashboards.
 */
export const catchOAuthTokenFailure = {
	"@maple/http/errors/IntegrationsNotConnectedError": (error: IntegrationsNotConnectedError) =>
		Effect.fail(new ScrapeTargetAuthError({ reason: "not_connected", message: error.message })),
	"@maple/http/errors/IntegrationsRevokedError": (error: IntegrationsRevokedError) =>
		Effect.fail(new ScrapeTargetAuthError({ reason: "revoked", message: error.message })),
	"@maple/http/errors/IntegrationsUpstreamError": (error: IntegrationsUpstreamError) =>
		Effect.fail(
			new ScrapeTargetAuthError({
				reason: "upstream",
				message: `PlanetScale token refresh failed upstream: ${error.message}`,
			}),
		),
	"@maple/http/errors/IntegrationsValidationError": (error: IntegrationsValidationError) =>
		Effect.fail(new ScrapeTargetAuthError({ reason: "config", message: error.message })),
	"@maple/http/errors/IntegrationsPersistenceError": (error: IntegrationsPersistenceError) =>
		Effect.fail(new ScrapeTargetPersistenceError({ message: error.message })),
} as const

const decodeCredentials = <S extends Schema.Top>(schema: S, credentialsJson: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(credentialsJson).pipe(
		Effect.mapError(() => toEncryptionError("Failed to decode auth credentials")),
	)

export const buildScrapeAuthHeaders = Effect.fn("buildScrapeAuthHeaders")(function* (
	row: ScrapeAuthRowLike,
	encryptionKey: Buffer,
) {
	const headers: Record<string, string> = {}
	if (
		row.authType === "none" ||
		!row.authCredentialsCiphertext ||
		!row.authCredentialsIv ||
		!row.authCredentialsTag
	) {
		return headers
	}

	const credentialsJson = yield* decryptAes256Gcm(
		{
			ciphertext: row.authCredentialsCiphertext,
			iv: row.authCredentialsIv,
			tag: row.authCredentialsTag,
		},
		encryptionKey,
		() => toEncryptionError("Failed to decrypt auth credentials"),
	)

	if (row.authType === "bearer") {
		const credentials = yield* decodeCredentials(BearerCredentialsSchema, credentialsJson)
		headers.Authorization = `Bearer ${credentials.token}`
	} else if (row.authType === "basic") {
		const credentials = yield* decodeCredentials(BasicCredentialsSchema, credentialsJson)
		const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
		headers.Authorization = `Basic ${encoded}`
	} else if (row.authType === "token") {
		const credentials = yield* decodeCredentials(TokenCredentialsSchema, credentialsJson)
		headers.Authorization = `token ${credentials.tokenId}:${credentials.tokenSecret}`
	}

	return headers
})
