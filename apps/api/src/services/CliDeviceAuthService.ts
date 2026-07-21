import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
	CliDeviceActionResponse,
	CliDeviceCompleteResponse,
	CliDeviceConflictError,
	CliDeviceDeniedResponse,
	CliDeviceExpiredError,
	CliDeviceExpiredResponse,
	CliDeviceInfoResponse,
	CliDeviceNotFoundError,
	CliDevicePendingResponse,
	CliDevicePersistenceError,
	CliDeviceRateLimitError,
	CliDeviceStartResponse,
	ApiKeyId,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import {
	apiKeys as apiKeysTable,
	cliDeviceAuthorizations,
	generateApiKey,
	hashApiKey,
	parseIngestKeyLookupHmacKey,
} from "@maple/db"
import { and, eq, isNull, lt } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Database } from "../lib/DatabaseLive"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "../lib/Crypto"
import { Env } from "../lib/Env"
import { WorkerEnvironment } from "../lib/WorkerEnvironment"

const DEVICE_TTL_SECONDS = 15 * 60
const POLL_INTERVAL_SECONDS = 5
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const CLI_AUTH_RATE_LIMIT_BINDING = "CLI_AUTH_RATE_LIMITER"

interface RateLimitBinding {
	readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>
}

const isRateLimitBinding = (value: unknown): value is RateLimitBinding =>
	typeof value === "object" &&
	value !== null &&
	"limit" in value &&
	typeof (value as { limit?: unknown }).limit === "function"

const hashCode = (value: string) => createHash("sha256").update(value).digest("hex")
const normalizeUserCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "")
const displayUserCode = (value: string) => `${value.slice(0, 4)}-${value.slice(4, 8)}`
const decodeApiKeyId = Schema.decodeUnknownSync(ApiKeyId)

const makeUserCode = () => {
	const bytes = randomBytes(8)
	let value = ""
	for (let index = 0; index < 8; index += 1) {
		value += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length]
	}
	return value
}

const persistenceError = (error: unknown) =>
	new CliDevicePersistenceError({
		message: error instanceof Error ? error.message : "CLI device authorization persistence failed",
	})

type ApprovalIdentity = {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: ReadonlyArray<RoleName>
	readonly userEmail: string | null
}

type PollResponse =
	| CliDevicePendingResponse
	| CliDeviceCompleteResponse
	| CliDeviceDeniedResponse
	| CliDeviceExpiredResponse

export class CliDeviceAuthService extends Context.Service<
	CliDeviceAuthService,
	{
		readonly start: (
			deviceName: string,
			requesterKey: string,
		) => Effect.Effect<CliDeviceStartResponse, CliDevicePersistenceError | CliDeviceRateLimitError>
		readonly poll: (
			deviceCode: string,
		) => Effect.Effect<
			| CliDevicePendingResponse
			| CliDeviceCompleteResponse
			| CliDeviceDeniedResponse
			| CliDeviceExpiredResponse,
			CliDevicePersistenceError | CliDeviceRateLimitError
		>
		readonly inspect: (
			userCode: string,
		) => Effect.Effect<
			CliDeviceInfoResponse,
			CliDeviceNotFoundError | CliDeviceExpiredError | CliDevicePersistenceError
		>
		readonly approve: (
			userCode: string,
			identity: ApprovalIdentity,
		) => Effect.Effect<
			CliDeviceActionResponse,
			| CliDeviceNotFoundError
			| CliDeviceExpiredError
			| CliDeviceConflictError
			| CliDevicePersistenceError
		>
		readonly deny: (
			userCode: string,
		) => Effect.Effect<
			CliDeviceActionResponse,
			| CliDeviceNotFoundError
			| CliDeviceExpiredError
			| CliDeviceConflictError
			| CliDevicePersistenceError
		>
	}
>()("@maple/api/services/CliDeviceAuthService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const workerEnvironment = yield* Effect.serviceOption(WorkerEnvironment)
		const apiKeyHmacKey = yield* Effect.try({
			try: () => parseIngestKeyLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY)),
			catch: (error) =>
				new CliDevicePersistenceError({
					message: error instanceof Error ? error.message : "Invalid API key lookup HMAC key",
				}),
		}).pipe(Effect.orDie)
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new CliDevicePersistenceError({ message }),
		).pipe(Effect.orDie)

		const purgeExpired = Effect.fn("CliDeviceAuthService.purgeExpired")(function* (now: number) {
			yield* database
				.execute((db) =>
					db
						.delete(cliDeviceAuthorizations)
						.where(lt(cliDeviceAuthorizations.expiresAt, new Date(now))),
				)
				.pipe(Effect.mapError(persistenceError))
		})

		const checkRateLimit = Effect.fn("CliDeviceAuthService.checkRateLimit")(function* (key: string) {
			if (Option.isNone(workerEnvironment)) return
			const binding = workerEnvironment.value[CLI_AUTH_RATE_LIMIT_BINDING]
			if (!isRateLimitBinding(binding)) return
			const outcome = yield* Effect.tryPromise({
				try: () => binding.limit({ key: `${env.MAPLE_ENVIRONMENT}:cli-auth:${key}` }),
				catch: () => new CliDevicePersistenceError({ message: "CLI auth rate limiter unavailable" }),
			}).pipe(Effect.orElseSucceed(() => undefined))
			if (outcome && !outcome.success) {
				return yield* new CliDeviceRateLimitError({
					message: "Too many CLI login attempts. Wait a minute and try again.",
				})
			}
		})

		const findByUserCode = Effect.fn("CliDeviceAuthService.findByUserCode")(function* (userCode: string) {
			const normalized = normalizeUserCode(userCode)
			if (normalized.length !== 8) {
				return yield* new CliDeviceNotFoundError({ message: "CLI login code not found" })
			}
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(cliDeviceAuthorizations)
						.where(eq(cliDeviceAuthorizations.userCodeHash, hashCode(normalized)))
						.limit(1),
				)
				.pipe(Effect.mapError(persistenceError))
			const row = Option.fromNullishOr(rows[0])
			if (Option.isNone(row)) {
				return yield* new CliDeviceNotFoundError({ message: "CLI login code not found" })
			}
			return { row: row.value, normalized }
		})

		const requireActive = Effect.fn("CliDeviceAuthService.requireActive")(function* (userCode: string) {
			const found = yield* findByUserCode(userCode)
			const now = yield* Clock.currentTimeMillis
			if (found.row.expiresAt.getTime() <= now) {
				return yield* new CliDeviceExpiredError({ message: "CLI login code has expired" })
			}
			return found
		})

		const start = Effect.fn("CliDeviceAuthService.start")(function* (
			deviceName: string,
			requesterKey: string,
		) {
			yield* checkRateLimit(`start:${requesterKey}`)
			const now = yield* Clock.currentTimeMillis
			yield* purgeExpired(now)
			const deviceCode = randomBytes(32).toString("base64url")
			const userCode = makeUserCode()
			const verificationUri = `${env.MAPLE_APP_BASE_URL.replace(/\/+$/, "")}/cli-login`
			yield* database
				.execute((db) =>
					db.insert(cliDeviceAuthorizations).values({
						deviceCodeHash: hashCode(deviceCode),
						userCodeHash: hashCode(userCode),
						deviceName: deviceName.trim().slice(0, 120) || "Maple CLI",
						createdAt: new Date(now),
						expiresAt: new Date(now + DEVICE_TTL_SECONDS * 1000),
					}),
				)
				.pipe(Effect.mapError(persistenceError))
			const displayed = displayUserCode(userCode)
			return new CliDeviceStartResponse({
				deviceCode,
				userCode: displayed,
				verificationUri,
				verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(displayed)}`,
				expiresIn: DEVICE_TTL_SECONDS,
				interval: POLL_INTERVAL_SECONDS,
			})
		})

		const inspect = Effect.fn("CliDeviceAuthService.inspect")(function* (userCode: string) {
			const { row, normalized } = yield* requireActive(userCode)
			const status = row.deniedAt
				? ("denied" as const)
				: row.apiKeyId
					? ("complete" as const)
					: row.approvedAt
						? ("approved" as const)
						: ("pending" as const)
			return new CliDeviceInfoResponse({
				userCode: displayUserCode(normalized),
				deviceName: row.deviceName,
				expiresAt: row.expiresAt.toISOString(),
				status,
			})
		})

		const approve = Effect.fn("CliDeviceAuthService.approve")(function* (
			userCode: string,
			identity: ApprovalIdentity,
		) {
			const { row } = yield* requireActive(userCode)
			if (row.approvedAt || row.deniedAt) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			const now = yield* Clock.currentTimeMillis
			const updated = yield* database
				.execute((db) =>
					db
						.update(cliDeviceAuthorizations)
						.set({
							approvedOrgId: identity.orgId,
							approvedUserId: identity.userId,
							approvedRoles: [...identity.roles],
							approvedUserEmail: identity.userEmail,
							approvedAt: new Date(now),
						})
						.where(
							and(
								eq(cliDeviceAuthorizations.deviceCodeHash, row.deviceCodeHash),
								isNull(cliDeviceAuthorizations.approvedAt),
								isNull(cliDeviceAuthorizations.deniedAt),
							),
						)
						.returning({ deviceCodeHash: cliDeviceAuthorizations.deviceCodeHash }),
				)
				.pipe(Effect.mapError(persistenceError))
			if (updated.length === 0) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			return new CliDeviceActionResponse({ status: "approved" })
		})

		const deny = Effect.fn("CliDeviceAuthService.deny")(function* (userCode: string) {
			const { row } = yield* requireActive(userCode)
			if (row.approvedAt || row.deniedAt) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			const now = yield* Clock.currentTimeMillis
			const updated = yield* database
				.execute((db) =>
					db
						.update(cliDeviceAuthorizations)
						.set({ deniedAt: new Date(now) })
						.where(
							and(
								eq(cliDeviceAuthorizations.deviceCodeHash, row.deviceCodeHash),
								isNull(cliDeviceAuthorizations.approvedAt),
								isNull(cliDeviceAuthorizations.deniedAt),
							),
						)
						.returning({ deviceCodeHash: cliDeviceAuthorizations.deviceCodeHash }),
				)
				.pipe(Effect.mapError(persistenceError))
			if (updated.length === 0) {
				return yield* new CliDeviceConflictError({ message: "CLI login code was already used" })
			}
			return new CliDeviceActionResponse({ status: "denied" })
		})

		const loadByDeviceCode = Effect.fn("CliDeviceAuthService.loadByDeviceCode")(function* (
			deviceCode: string,
		) {
			return yield* loadByDeviceCodeHash(hashCode(deviceCode))
		})

		const loadByDeviceCodeHash = Effect.fn("CliDeviceAuthService.loadByDeviceCodeHash")(function* (
			deviceCodeHash: string,
		) {
			const rows = yield* database
				.execute((db) =>
					db
						.select()
						.from(cliDeviceAuthorizations)
						.where(eq(cliDeviceAuthorizations.deviceCodeHash, deviceCodeHash))
						.limit(1),
				)
				.pipe(Effect.mapError(persistenceError))
			return Option.fromNullishOr(rows[0])
		})

		const completeFromRow: (
			row: typeof cliDeviceAuthorizations.$inferSelect,
		) => Effect.Effect<PollResponse, CliDevicePersistenceError> = Effect.fn(
			"CliDeviceAuthService.completeFromRow",
		)(function* (row: typeof cliDeviceAuthorizations.$inferSelect) {
			if (!row.approvedOrgId || !row.approvedUserId || !row.approvedRoles) {
				return new CliDevicePendingResponse({ status: "pending", interval: POLL_INTERVAL_SECONDS })
			}
			if (row.tokenCiphertext && row.tokenIv && row.tokenTag) {
				const token = yield* decryptAes256Gcm(
					{ ciphertext: row.tokenCiphertext, iv: row.tokenIv, tag: row.tokenTag },
					encryptionKey,
					(message) => new CliDevicePersistenceError({ message }),
				)
				return new CliDeviceCompleteResponse({
					status: "complete",
					token,
					orgId: row.approvedOrgId as OrgId,
					userId: row.approvedUserId as UserId,
				})
			}

			const apiKeyId = decodeApiKeyId(randomUUID())
			const rawToken = generateApiKey()
			const encrypted = yield* encryptAes256Gcm(
				rawToken,
				encryptionKey,
				(message) => new CliDevicePersistenceError({ message }),
			)
			const now = yield* Clock.currentTimeMillis
			const won = yield* database
				.execute((db) =>
					db.transaction(async (tx) => {
						const claimed = await tx
							.update(cliDeviceAuthorizations)
							.set({
								apiKeyId,
								tokenCiphertext: encrypted.ciphertext,
								tokenIv: encrypted.iv,
								tokenTag: encrypted.tag,
							})
							.where(
								and(
									eq(cliDeviceAuthorizations.deviceCodeHash, row.deviceCodeHash),
									isNull(cliDeviceAuthorizations.apiKeyId),
								),
							)
							.returning({ deviceCodeHash: cliDeviceAuthorizations.deviceCodeHash })
						if (claimed.length === 0) return false
						await tx.insert(apiKeysTable).values({
							id: apiKeyId,
							orgId: row.approvedOrgId!,
							name: row.deviceName,
							description: "Created by maple auth login",
							keyHash: hashApiKey(rawToken, apiKeyHmacKey),
							keyPrefix: rawToken.slice(0, 12) + "...",
							kind: "standard",
							scopes: null,
							metadataJson: {
								source: "maple_cli",
								roles: row.approvedRoles,
								deviceName: row.deviceName,
							},
							createdAt: new Date(now),
							createdBy: row.approvedUserId!,
							createdByEmail: row.approvedUserEmail,
						})
						return true
					}),
				)
				.pipe(Effect.mapError(persistenceError))
			if (!won) {
				const winner = yield* loadByDeviceCodeHash(row.deviceCodeHash)
				if (
					Option.isSome(winner) &&
					winner.value.tokenCiphertext &&
					winner.value.tokenIv &&
					winner.value.tokenTag
				) {
					const token = yield* decryptAes256Gcm(
						{
							ciphertext: winner.value.tokenCiphertext,
							iv: winner.value.tokenIv,
							tag: winner.value.tokenTag,
						},
						encryptionKey,
						(message) => new CliDevicePersistenceError({ message }),
					)
					return new CliDeviceCompleteResponse({
						status: "complete",
						token,
						orgId: row.approvedOrgId as OrgId,
						userId: row.approvedUserId as UserId,
					})
				}
				return yield* new CliDevicePersistenceError({ message: "CLI credential issuance raced" })
			}
			return new CliDeviceCompleteResponse({
				status: "complete",
				token: rawToken,
				orgId: row.approvedOrgId as OrgId,
				userId: row.approvedUserId as UserId,
			})
		})

		const poll = Effect.fn("CliDeviceAuthService.poll")(function* (deviceCode: string) {
			yield* checkRateLimit(`poll:${hashCode(deviceCode)}`)
			const row = yield* loadByDeviceCode(deviceCode)
			if (Option.isNone(row)) return new CliDeviceExpiredResponse({ status: "expired" })
			const now = yield* Clock.currentTimeMillis
			if (row.value.expiresAt.getTime() <= now) {
				yield* purgeExpired(now)
				return new CliDeviceExpiredResponse({ status: "expired" })
			}
			if (row.value.deniedAt) return new CliDeviceDeniedResponse({ status: "denied" })
			if (!row.value.approvedAt) {
				return new CliDevicePendingResponse({ status: "pending", interval: POLL_INTERVAL_SECONDS })
			}
			return yield* completeFromRow(row.value)
		})

		return { start, poll, inspect, approve, deny }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
