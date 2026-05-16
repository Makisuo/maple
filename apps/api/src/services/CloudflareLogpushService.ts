import { randomBytes, randomUUID } from "node:crypto"
import {
	CloudflareLogpushConnectorId,
	CloudflareLogpushConnectorResponse,
	CloudflareLogpushCreateResponse,
	CloudflareLogpushDeleteResponse,
	CloudflareLogpushEncryptionError,
	CloudflareLogpushListResponse,
	CloudflareLogpushNotFoundError,
	CloudflareLogpushPersistenceError,
	CloudflareLogpushSetupResponse,
	CloudflareLogpushValidationError,
	IsoDateTimeString,
	OrgId,
	UserId,
	type CreateCloudflareLogpushConnectorRequest,
	type UpdateCloudflareLogpushConnectorRequest,
} from "@maple/domain/http"
import {
	cloudflareLogpushConnectors,
	hashCloudflareLogpushSecret,
	parseCloudflareLogpushSecretHmacKey,
} from "@maple/db"
import { and, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey, type EncryptedValue } from "./Crypto"
import { Database } from "./DatabaseLive"
import { Env } from "./Env"

const DATASET = "http_requests"
const OUTPUT_TYPE = "ndjson"
const TIMESTAMP_FORMAT = "unixnano"

const RECOMMENDED_FIELD_NAMES = [
	"EdgeStartTimestamp",
	"EdgeEndTimestamp",
	"RayID",
	"ClientIP",
	"ClientCountry",
	"ClientRequestHost",
	"ClientRequestMethod",
	"ClientRequestURI",
	"ClientRequestProtocol",
	"ClientRequestUserAgent",
	"EdgeResponseStatus",
	"EdgeColoCode",
	"CacheCacheStatus",
	"ZoneName",
] as const

const CLOUDFLARE_SETUP_STEPS = [
	"Open Cloudflare Logpush for the target zone and create a new job for the HTTP requests dataset.",
	"Choose HTTP as the destination type and paste the generated destination_conf value if you are using the Cloudflare API.",
	"Set the output options to NDJSON and UnixNano timestamps.",
	"Include the recommended field list exactly so Maple can map request logs consistently.",
	"Save the job and wait for Cloudflare's gzipped validation request to succeed before sending live traffic.",
] as const

type CloudflareLogpushConnectorRow = typeof cloudflareLogpushConnectors.$inferSelect

export interface CloudflareLogpushServiceShape {
	readonly list: (
		orgId: OrgId,
	) => Effect.Effect<CloudflareLogpushListResponse, CloudflareLogpushPersistenceError>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		request: CreateCloudflareLogpushConnectorRequest,
	) => Effect.Effect<
		CloudflareLogpushCreateResponse,
		| CloudflareLogpushValidationError
		| CloudflareLogpushPersistenceError
		| CloudflareLogpushEncryptionError
	>
	readonly update: (
		orgId: OrgId,
		connectorId: CloudflareLogpushConnectorId,
		userId: UserId,
		request: UpdateCloudflareLogpushConnectorRequest,
	) => Effect.Effect<
		CloudflareLogpushConnectorResponse,
		CloudflareLogpushNotFoundError | CloudflareLogpushValidationError | CloudflareLogpushPersistenceError
	>
	readonly delete: (
		orgId: OrgId,
		connectorId: CloudflareLogpushConnectorId,
	) => Effect.Effect<
		CloudflareLogpushDeleteResponse,
		CloudflareLogpushNotFoundError | CloudflareLogpushPersistenceError
	>
	readonly getSetup: (
		orgId: OrgId,
		connectorId: CloudflareLogpushConnectorId,
	) => Effect.Effect<
		CloudflareLogpushSetupResponse,
		CloudflareLogpushNotFoundError | CloudflareLogpushPersistenceError | CloudflareLogpushEncryptionError
	>
	readonly rotateSecret: (
		orgId: OrgId,
		connectorId: CloudflareLogpushConnectorId,
		userId: UserId,
	) => Effect.Effect<
		CloudflareLogpushSetupResponse,
		CloudflareLogpushNotFoundError | CloudflareLogpushPersistenceError | CloudflareLogpushEncryptionError
	>
}

const toPersistenceError = (error: unknown) =>
	new CloudflareLogpushPersistenceError({
		message: error instanceof Error ? error.message : "Cloudflare Logpush persistence failed",
	})

const toEncryptionError = (message: string) => new CloudflareLogpushEncryptionError({ message })

const decodeConnectorIdSync = Schema.decodeUnknownSync(CloudflareLogpushConnectorId)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(IsoDateTimeString)

const parseEncryptionKey = (raw: string): Effect.Effect<Buffer, CloudflareLogpushEncryptionError> =>
	parseBase64Aes256GcmKey(raw, (message) =>
		toEncryptionError(
			message === "Expected a non-empty base64 encryption key"
				? "MAPLE_INGEST_KEY_ENCRYPTION_KEY is required"
				: message === "Expected base64 for exactly 32 bytes"
					? "MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64 for exactly 32 bytes"
					: message,
		),
	)

const parseLookupHmacKey = (raw: string): Effect.Effect<string, CloudflareLogpushEncryptionError> =>
	Effect.try({
		try: () => parseCloudflareLogpushSecretHmacKey(raw),
		catch: (error) =>
			toEncryptionError(
				error instanceof Error ? error.message : "Invalid Cloudflare connector lookup HMAC key",
			),
	})

const encryptSecret = (
	plaintext: string,
	encryptionKey: Buffer,
): Effect.Effect<EncryptedValue, CloudflareLogpushEncryptionError> =>
	encryptAes256Gcm(plaintext, encryptionKey, () =>
		toEncryptionError("Failed to encrypt Cloudflare connector secret"),
	)

const decryptSecret = (
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
): Effect.Effect<string, CloudflareLogpushEncryptionError> =>
	decryptAes256Gcm(encrypted, encryptionKey, () =>
		toEncryptionError("Failed to decrypt Cloudflare connector secret"),
	)

const generateSecret = () => `maple_cf_${randomBytes(24).toString("base64url")}`

const toIsoString = (value: number | null | undefined) =>
	value == null ? null : new Date(value).toISOString()

const normalizeIngestPublicUrl = (raw: string): string => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) return "http://127.0.0.1:3474"
	return trimmed.replace(/\/+$/, "")
}

const cleanRequiredString = (
	label: string,
	value: string,
): Effect.Effect<string, CloudflareLogpushValidationError> =>
	Effect.sync(() => value.trim()).pipe(
		Effect.flatMap((trimmed) =>
			trimmed.length > 0
				? Effect.succeed(trimmed)
				: Effect.fail(
						new CloudflareLogpushValidationError({
							message: `${label} is required`,
						}),
					),
		),
	)

const cleanOptionalServiceName = (
	value: string | null | undefined,
	zoneName: string,
): Effect.Effect<string, CloudflareLogpushValidationError> => {
	if (value == null) return Effect.succeed(`cloudflare/${zoneName}`)

	const trimmed = value.trim()
	if (trimmed.length === 0) {
		return Effect.fail(
			new CloudflareLogpushValidationError({
				message: "Service name cannot be empty",
			}),
		)
	}

	return Effect.succeed(trimmed)
}

export class CloudflareLogpushService extends Context.Service<
	CloudflareLogpushService,
	CloudflareLogpushServiceShape
>()("CloudflareLogpushService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const encryptionKey = yield* parseEncryptionKey(Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY))
		const lookupHmacKey = yield* parseLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY))
		const ingestPublicUrl = normalizeIngestPublicUrl(env.MAPLE_INGEST_PUBLIC_URL)

		const rowToConnector = (row: CloudflareLogpushConnectorRow): CloudflareLogpushConnectorResponse =>
			new CloudflareLogpushConnectorResponse({
				id: decodeConnectorIdSync(row.id),
				name: row.name,
				zoneName: row.zoneName,
				serviceName: row.serviceName,
				dataset: row.dataset,
				enabled: row.enabled === 1,
				lastReceivedAt:
					row.lastReceivedAt == null
						? null
						: decodeIsoDateTimeStringSync(toIsoString(row.lastReceivedAt)),
				lastError: row.lastError,
				secretRotatedAt: decodeIsoDateTimeStringSync(new Date(row.secretRotatedAt).toISOString()),
				createdAt: decodeIsoDateTimeStringSync(new Date(row.createdAt).toISOString()),
				updatedAt: decodeIsoDateTimeStringSync(new Date(row.updatedAt).toISOString()),
			})

		const buildSetup = Effect.fn("CloudflareLogpushService.buildSetup")(function* (
			row: CloudflareLogpushConnectorRow,
		) {
			const secret = yield* decryptSecret(
				{
					ciphertext: row.secretCiphertext,
					iv: row.secretIv,
					tag: row.secretTag,
				},
				encryptionKey,
			)

			const endpointUrl = `${ingestPublicUrl}/v1/logpush/cloudflare/http_requests/${row.id}`
			const destinationConf = `${endpointUrl}?secret=${encodeURIComponent(secret)}`

			return new CloudflareLogpushSetupResponse({
				connectorId: decodeConnectorIdSync(row.id),
				dataset: DATASET,
				destinationConf,
				recommendedOutputType: OUTPUT_TYPE,
				recommendedTimestampFormat: TIMESTAMP_FORMAT,
				recommendedFieldNames: [...RECOMMENDED_FIELD_NAMES],
				validationNote:
					"Cloudflare sends a gzipped validation payload during setup. Maple accepts it and returns 200 without storing a log record.",
				cloudflareSetupSteps: [...CLOUDFLARE_SETUP_STEPS],
			})
		})

		const selectById = Effect.fn("CloudflareLogpushService.selectById")(function* (
			orgId: OrgId,
			connectorId: CloudflareLogpushConnectorId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(cloudflareLogpushConnectors)
						.where(
							and(
								eq(cloudflareLogpushConnectors.orgId, orgId),
								eq(cloudflareLogpushConnectors.id, connectorId),
							),
						)
						.limit(1),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return Option.fromNullishOr(rows[0])
		})

		const selectByIdOrPersistenceError = Effect.fn(
			"CloudflareLogpushService.selectByIdOrPersistenceError",
		)(function* (orgId: OrgId, connectorId: CloudflareLogpushConnectorId) {
			const row = yield* selectById(orgId, connectorId)
			if (Option.isSome(row)) return row.value

			return yield* Effect.fail(
				new CloudflareLogpushPersistenceError({
					message: "Failed to load Cloudflare Logpush connector",
				}),
			)
		})

		const requireConnector = Effect.fn("CloudflareLogpushService.requireConnector")(function* (
			orgId: OrgId,
			connectorId: CloudflareLogpushConnectorId,
		) {
			const row = yield* selectById(orgId, connectorId)
			if (Option.isSome(row)) return row.value

			return yield* Effect.fail(
				new CloudflareLogpushNotFoundError({
					connectorId,
					message: "Cloudflare Logpush connector not found",
				}),
			)
		})

		const list = Effect.fn("CloudflareLogpushService.list")(function* (orgId: OrgId) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(cloudflareLogpushConnectors)
						.where(eq(cloudflareLogpushConnectors.orgId, orgId)),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return new CloudflareLogpushListResponse({
				connectors: rows.map(rowToConnector),
			})
		})

		const create = Effect.fn("CloudflareLogpushService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			request: CreateCloudflareLogpushConnectorRequest,
		) {
			const name = yield* cleanRequiredString("Name", request.name)
			const zoneName = yield* cleanRequiredString("Zone name", request.zoneName)
			const serviceName = yield* cleanOptionalServiceName(request.serviceName, zoneName)

			const now = yield* Clock.currentTimeMillis
			const id = decodeConnectorIdSync(randomUUID())
			const secret = generateSecret()
			const secretHash = hashCloudflareLogpushSecret(secret, lookupHmacKey)
			const encryptedSecret = yield* encryptSecret(secret, encryptionKey)

			yield* database
				.execute((db) =>
					db.insert(cloudflareLogpushConnectors).values({
						id,
						orgId,
						name,
						zoneName,
						serviceName,
						dataset: DATASET,
						secretCiphertext: encryptedSecret.ciphertext,
						secretIv: encryptedSecret.iv,
						secretTag: encryptedSecret.tag,
						secretHash,
						enabled: request.enabled === false ? 0 : 1,
						lastReceivedAt: null,
						lastError: null,
						secretRotatedAt: now,
						createdAt: now,
						updatedAt: now,
						createdBy: userId,
						updatedBy: userId,
					}),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const row = yield* selectByIdOrPersistenceError(orgId, id)

			return new CloudflareLogpushCreateResponse({
				connector: rowToConnector(row),
				setup: yield* buildSetup(row),
			})
		})

		const update = Effect.fn("CloudflareLogpushService.update")(function* (
			orgId: OrgId,
			connectorId: CloudflareLogpushConnectorId,
			userId: UserId,
			request: UpdateCloudflareLogpushConnectorRequest,
		) {
			const existing = yield* requireConnector(orgId, connectorId)
			const updates: Record<string, unknown> = {
				updatedAt: yield* Clock.currentTimeMillis,
				updatedBy: userId,
			}

			const zoneName =
				request.zoneName !== undefined
					? yield* cleanRequiredString("Zone name", request.zoneName)
					: existing.zoneName

			if (request.name !== undefined) {
				updates.name = yield* cleanRequiredString("Name", request.name)
			}
			if (request.zoneName !== undefined) {
				updates.zoneName = zoneName
			}
			if (request.serviceName !== undefined) {
				updates.serviceName = yield* cleanOptionalServiceName(request.serviceName, zoneName)
			}
			if (request.enabled !== undefined) {
				updates.enabled = request.enabled ? 1 : 0
			}

			yield* database
				.execute((db) =>
					db
						.update(cloudflareLogpushConnectors)
						.set(updates)
						.where(
							and(
								eq(cloudflareLogpushConnectors.orgId, orgId),
								eq(cloudflareLogpushConnectors.id, connectorId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return rowToConnector(yield* requireConnector(orgId, connectorId))
		})

		const remove = Effect.fn("CloudflareLogpushService.delete")(function* (
			orgId: OrgId,
			connectorId: CloudflareLogpushConnectorId,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.delete(cloudflareLogpushConnectors)
						.where(
							and(
								eq(cloudflareLogpushConnectors.orgId, orgId),
								eq(cloudflareLogpushConnectors.id, connectorId),
							),
						)
						.returning({ id: cloudflareLogpushConnectors.id }),
				)
				.pipe(Effect.mapError(toPersistenceError))

			const deleted = Option.fromNullishOr(rows[0])
			if (Option.isSome(deleted)) {
				return new CloudflareLogpushDeleteResponse({
					id: decodeConnectorIdSync(deleted.value.id),
				})
			}

			return yield* Effect.fail(
				new CloudflareLogpushNotFoundError({
					connectorId,
					message: "Cloudflare Logpush connector not found",
				}),
			)
		})

		const getSetup = Effect.fn("CloudflareLogpushService.getSetup")(function* (
			orgId: OrgId,
			connectorId: CloudflareLogpushConnectorId,
		) {
			return yield* buildSetup(yield* requireConnector(orgId, connectorId))
		})

		const rotateSecret = Effect.fn("CloudflareLogpushService.rotateSecret")(function* (
			orgId: OrgId,
			connectorId: CloudflareLogpushConnectorId,
			userId: UserId,
		) {
			yield* requireConnector(orgId, connectorId)

			const now = yield* Clock.currentTimeMillis
			const secret = generateSecret()
			const secretHash = hashCloudflareLogpushSecret(secret, lookupHmacKey)
			const encryptedSecret = yield* encryptSecret(secret, encryptionKey)

			yield* database
				.execute((db) =>
					db
						.update(cloudflareLogpushConnectors)
						.set({
							secretCiphertext: encryptedSecret.ciphertext,
							secretIv: encryptedSecret.iv,
							secretTag: encryptedSecret.tag,
							secretHash,
							secretRotatedAt: now,
							updatedAt: now,
							updatedBy: userId,
						})
						.where(
							and(
								eq(cloudflareLogpushConnectors.orgId, orgId),
								eq(cloudflareLogpushConnectors.id, connectorId),
							),
						),
				)
				.pipe(Effect.mapError(toPersistenceError))

			return yield* buildSetup(yield* requireConnector(orgId, connectorId))
		})

		return {
			list,
			create,
			update,
			delete: remove,
			getSetup,
			rotateSecret,
		} satisfies CloudflareLogpushServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly list = (orgId: OrgId) => this.use((service) => service.list(orgId))

	static readonly create = (
		orgId: OrgId,
		userId: UserId,
		request: CreateCloudflareLogpushConnectorRequest,
	) => this.use((service) => service.create(orgId, userId, request))

	static readonly update = (
		orgId: OrgId,
		connectorId: CloudflareLogpushConnectorId,
		userId: UserId,
		request: UpdateCloudflareLogpushConnectorRequest,
	) => this.use((service) => service.update(orgId, connectorId, userId, request))

	static readonly delete = (orgId: OrgId, connectorId: CloudflareLogpushConnectorId) =>
		this.use((service) => service.delete(orgId, connectorId))

	static readonly getSetup = (orgId: OrgId, connectorId: CloudflareLogpushConnectorId) =>
		this.use((service) => service.getSetup(orgId, connectorId))

	static readonly rotateSecret = (
		orgId: OrgId,
		connectorId: CloudflareLogpushConnectorId,
		userId: UserId,
	) => this.use((service) => service.rotateSecret(orgId, connectorId, userId))
}
