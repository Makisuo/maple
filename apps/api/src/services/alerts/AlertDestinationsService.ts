import {
	AlertDeliveryError,
	AlertDestinationDecryptionError,
	AlertDestinationDeleteResponse,
	AlertDestinationDocument,
	AlertDestinationEncryptionError,
	AlertDestinationStoredConfigInvalidError,
	AlertDestinationType as AlertDestinationTypeSchema,
	AlertDestinationInUseError,
	AlertDestinationTestResponse,
	AlertDestinationsListResponse,
	AlertForbiddenError,
	AlertDestinationNotFoundError,
	AlertPersistenceError,
	AlertRuleDocument,
	AlertRuleStoredConfigInvalidError,
	AlertValidationError,
	RoleName,
	type AlertDestinationCreateRequest,
	type AlertDestinationUpdateRequest,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { alertDestinations, alertRules, type AlertDestinationRow } from "@maple/db"
import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Match, Option, Redacted, Schema } from "effect"
import { encryptAes256Gcm, type EncryptedValue } from "@/platform/Crypto"
import { Database } from "@/platform/DatabaseLive"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { readTxid, txidColumn } from "@/platform/electric-txid"
import { validateExternalUrl } from "@/http/url-validator"
import { HazelOAuthService, type HazelOAuthServiceShape } from "@/services/auth/HazelOAuthService"
import { makeDbExecute } from "@/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import {
	OrgMembersService,
	type OrgMember,
	type OrgMembersServiceShape,
} from "@/services/org/OrgMembersService"
import { SlackBotTokenResolver } from "@/services/integrations/slack-bot-token"
import { PAGERDUTY_ROUTING_KEY_PATTERN, verifyPagerDutyRoutingKey } from "./delivery/transports/pagerduty"
import {
	DestinationPublicConfigSchema,
	type DestinationPublicConfig,
	type DestinationSecretConfig,
} from "./AlertDestinationHydration"
import { makeAlertDestinationDelivery, parseAlertDestinationEncryptionKey } from "./AlertDestinationDelivery"
import { AlertRuntime } from "./AlertRuntime"
import { decodeStoredAlertRuleDestinationIds } from "./AlertRuleModel"

const decodeAlertDestinationIdSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.id)
const decodeAlertDestinationTypeSync = Schema.decodeUnknownSync(AlertDestinationTypeSchema)
const decodeAlertRuleIdSync = Schema.decodeUnknownSync(AlertRuleDocument.fields.id)
const decodeIsoDateTimeStringSync = Schema.decodeUnknownSync(AlertDestinationDocument.fields.createdAt)
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)

const adminRoles = [decodeRoleNameSync("root"), decodeRoleNameSync("org:admin")]

const makeValidationError = (message: string, details: ReadonlyArray<string> = [], cause?: unknown) =>
	new AlertValidationError({ message, details, ...(cause === undefined ? {} : { cause }) })

const normalizeOptionalString = (value: string | null | undefined) => {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

const validateDestinationUrl = (rawUrl: string, field: string): Effect.Effect<string, AlertValidationError> =>
	validateExternalUrl(rawUrl).pipe(
		Effect.as(rawUrl.trim()),
		Effect.mapError((error) => makeValidationError(`${field}: ${error.message}`, [], error)),
	)

const summarizeMembers = (members: ReadonlyArray<OrgMember>): string => {
	const first = members[0]
	if (first === undefined) return "Email"
	const label = first.name ?? first.email
	return members.length === 1 ? label : `${label} +${members.length - 1} more`
}

const emailPublicConfig = (members: ReadonlyArray<OrgMember>): DestinationPublicConfig => ({
	summary: summarizeMembers(members),
	channelLabel: members[0]?.email ?? null,
	memberUserIds: members.map((member) => member.userId),
})

const emailSecretConfig = (members: ReadonlyArray<OrgMember>): DestinationSecretConfig => ({
	type: "email",
	members: members.map((member) => ({
		userId: member.userId,
		email: member.email,
		name: member.name,
	})),
})

type AlertDestinationDependencyError =
	| Effect.Error<ReturnType<HazelOAuthServiceShape["createChannelWebhook"]>>
	| Effect.Error<ReturnType<OrgMembersServiceShape["resolveMembers"]>>

const encryptSecret = (
	plaintext: string,
	encryptionKey: Buffer,
	destinationId: AlertDestinationDocument["id"],
): Effect.Effect<EncryptedValue, AlertDestinationEncryptionError> =>
	encryptAes256Gcm(
		plaintext,
		encryptionKey,
		() =>
			new AlertDestinationEncryptionError({
				message: "Failed to encrypt destination secret",
				destinationId,
			}),
	)

const summarizeWebhookUrl = (url: string) =>
	Option.match(Option.liftThrowable(() => new URL(url))(), {
		onNone: () => "Webhook endpoint",
		onSome: (parsed) => `POST ${parsed.host}`,
	})

const buildPublicConfig = (
	request: Exclude<AlertDestinationCreateRequest, { readonly type: "email" }>,
): DestinationPublicConfig =>
	Match.value(request).pipe(
		Match.discriminatorsExhaustive("type")({
			"slack-bot": (r) => ({
				summary: r.channelName?.trim() ? `#${r.channelName.trim()}` : "Slack channel",
				channelLabel: r.channelName?.trim() ? `#${r.channelName.trim()}` : null,
			}),
			pagerduty: () => ({ summary: "PagerDuty Events API v2", channelLabel: null }),
			webhook: (r) => ({ summary: summarizeWebhookUrl(r.url), channelLabel: null }),
			"hazel-oauth": (r) => ({
				summary: `${r.hazelOrganizationName} · #${r.hazelChannelName}`,
				channelLabel: `#${r.hazelChannelName}`,
				hazelOrganizationId: r.hazelOrganizationId,
				hazelOrganizationName: r.hazelOrganizationName,
				hazelOrganizationLogoUrl: r.hazelOrganizationLogoUrl ?? null,
				hazelChannelId: r.hazelChannelId,
				hazelChannelName: r.hazelChannelName,
			}),
			discord: (r) => ({ summary: summarizeWebhookUrl(r.webhookUrl), channelLabel: null }),
		}),
	)

const buildSecretConfig = (
	request: Exclude<AlertDestinationCreateRequest, { readonly type: "hazel-oauth" | "email" }>,
): DestinationSecretConfig =>
	Match.value(request).pipe(
		Match.discriminatorsExhaustive("type")({
			"slack-bot": (r) => ({
				type: "slack-bot" as const,
				channelId: r.channelId.trim(),
				channelName: normalizeOptionalString(r.channelName),
			}),
			pagerduty: (r) => ({ type: "pagerduty" as const, integrationKey: r.integrationKey.trim() }),
			webhook: (r) => ({
				type: "webhook" as const,
				url: r.url.trim(),
				signingSecret: normalizeOptionalString(r.signingSecret),
			}),
			discord: (r) => ({ type: "discord" as const, webhookUrl: r.webhookUrl.trim() }),
		}),
	)

const decodePublicConfig = (
	row: AlertDestinationRow,
): Effect.Effect<DestinationPublicConfig, AlertDestinationStoredConfigInvalidError> =>
	Schema.decodeUnknownEffect(DestinationPublicConfigSchema)(row.configJson).pipe(
		Effect.mapError(
			(cause) =>
				new AlertDestinationStoredConfigInvalidError({
					message: "Stored destination config is invalid",
					destinationId: row.id,
					component: "public_config",
					cause,
				}),
		),
	)

const destinationDocumentFromRow = (
	row: AlertDestinationRow,
	publicConfig: DestinationPublicConfig,
): AlertDestinationDocument =>
	new AlertDestinationDocument({
		id: decodeAlertDestinationIdSync(row.id),
		name: row.name,
		type: decodeAlertDestinationTypeSync(row.type),
		enabled: row.enabled,
		summary: publicConfig.summary,
		channelLabel: publicConfig.channelLabel,
		memberUserIds: publicConfig.memberUserIds != null ? [...publicConfig.memberUserIds] : null,
		lastTestedAt:
			row.lastTestedAt == null ? null : decodeIsoDateTimeStringSync(row.lastTestedAt.toISOString()),
		lastTestError: row.lastTestError,
		createdAt: decodeIsoDateTimeStringSync(row.createdAt.toISOString()),
		updatedAt: decodeIsoDateTimeStringSync(row.updatedAt.toISOString()),
	})

const rowToDestinationDocument = (
	row: AlertDestinationRow,
	publicConfig: DestinationPublicConfig,
): Effect.Effect<AlertDestinationDocument, AlertDestinationStoredConfigInvalidError> =>
	Effect.try({
		try: () => destinationDocumentFromRow(row, publicConfig),
		catch: (cause) =>
			new AlertDestinationStoredConfigInvalidError({
				message: "Stored destination document is invalid",
				destinationId: row.id,
				component: "document",
				cause,
			}),
	})

export interface AlertDestinationsServiceShape {
	readonly listDestinations: (
		orgId: OrgId,
	) => Effect.Effect<
		AlertDestinationsListResponse,
		AlertPersistenceError | AlertDestinationStoredConfigInvalidError
	>
	readonly createDestination: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: AlertDestinationCreateRequest,
	) => Effect.Effect<
		AlertDestinationDocument,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertDestinationEncryptionError
		| AlertDestinationDependencyError
	>
	readonly updateDestination: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		destinationId: AlertDestinationDocument["id"],
		request: AlertDestinationUpdateRequest,
	) => Effect.Effect<
		AlertDestinationDocument,
		| AlertForbiddenError
		| AlertValidationError
		| AlertPersistenceError
		| AlertDestinationNotFoundError
		| AlertDestinationEncryptionError
		| AlertDestinationDecryptionError
		| AlertDestinationStoredConfigInvalidError
		| AlertDestinationDependencyError
	>
	readonly deleteDestination: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		destinationId: AlertDestinationDocument["id"],
	) => Effect.Effect<
		AlertDestinationDeleteResponse,
		| AlertForbiddenError
		| AlertPersistenceError
		| AlertDestinationNotFoundError
		| AlertDestinationInUseError
		| AlertRuleStoredConfigInvalidError
	>
	readonly testDestination: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		destinationId: AlertDestinationDocument["id"],
	) => Effect.Effect<
		AlertDestinationTestResponse,
		| AlertForbiddenError
		| AlertPersistenceError
		| AlertDestinationNotFoundError
		| AlertDeliveryError
		| AlertDestinationDecryptionError
		| AlertDestinationStoredConfigInvalidError
	>
}

export class AlertDestinationsService extends Context.Service<
	AlertDestinationsService,
	AlertDestinationsServiceShape
>()("@maple/api/services/alerts/AlertDestinationsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const runtime = yield* AlertRuntime
		const hazelOAuth = yield* HazelOAuthService
		const email = yield* EmailService
		const orgMembers = yield* OrgMembersService
		const slackBotToken = yield* SlackBotTokenResolver
		const encryptionKey = yield* parseAlertDestinationEncryptionKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
		)
		const delivery = makeAlertDestinationDelivery({
			encryptionKey,
			appBaseUrl: env.MAPLE_APP_BASE_URL,
			runtime,
			email,
			resolveSlackBotToken: slackBotToken.resolve,
		})

		const dbExecute = makeDbExecute(database, "AlertDestinationsService", makePersistenceError)

		const requireAdmin = Effect.fn("AlertsService.requireAdmin")(function* (
			roles: ReadonlyArray<RoleName>,
		) {
			if (roles.some((role) => adminRoles.includes(role))) return
			return yield* Effect.fail(
				new AlertForbiddenError({
					message: "Only org admins can manage alerts",
					...(roles.length > 0 ? { roles: [...roles] } : {}),
				}),
			)
		})

		const requireDestinationRow = Effect.fn("AlertsService.requireDestinationRow")(function* (
			orgId: OrgId,
			destinationId: AlertDestinationDocument["id"],
		) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(alertDestinations)
					.where(and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)))
					.limit(1),
			)
			if (rows[0]) return rows[0]
			return yield* Effect.fail(
				new AlertDestinationNotFoundError({
					message: "Alert destination not found",
					destinationId,
				}),
			)
		})

		const resolveEmailMembers = (orgId: OrgId, memberUserIds: ReadonlyArray<UserId>) =>
			orgMembers
				.resolveMembers(orgId, memberUserIds)
				.pipe(
					Effect.flatMap((members) =>
						members.length === 0
							? Effect.fail(makeValidationError("At least one workspace member is required"))
							: Effect.succeed(members),
					),
				)

		const markDestinationTest = Effect.fn("AlertsService.markDestinationTest")(function* (
			orgId: OrgId,
			destinationId: AlertDestinationDocument["id"],
			errorMessage: string | null,
		) {
			const timestamp = yield* runtime.now
			yield* dbExecute((db) =>
				db
					.update(alertDestinations)
					.set({
						lastTestedAt: new Date(timestamp),
						lastTestError: errorMessage,
						updatedAt: new Date(timestamp),
					})
					.where(and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId))),
			)
		})

		const listDestinations = Effect.fn("AlertsService.listDestinations")(function* (orgId: OrgId) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(alertDestinations)
					.where(eq(alertDestinations.orgId, orgId))
					.orderBy(desc(alertDestinations.createdAt), desc(alertDestinations.id)),
			)
			const destinations = yield* Effect.forEach(rows, (row) =>
				Effect.flatMap(decodePublicConfig(row), (config) => rowToDestinationDocument(row, config)),
			)
			return new AlertDestinationsListResponse({ destinations })
		})

		const validatePagerDutyKey = Effect.fn("AlertsService.validatePagerDutyKey")(function* (
			integrationKey: string,
		) {
			if (!PAGERDUTY_ROUTING_KEY_PATTERN.test(integrationKey)) {
				return yield* Effect.fail(
					makeValidationError(
						"PagerDuty integration key must be a 32-character Events API v2 routing key — a REST API token won't work.",
					),
				)
			}
			const result = yield* verifyPagerDutyRoutingKey(
				integrationKey,
				runtime.fetch,
				runtime.deliveryTimeoutMs(),
				`maple-keycheck-${runtime.makeUuid()}`,
			)
			if (result.status === "invalid") {
				return yield* Effect.fail(
					makeValidationError(`PagerDuty rejected this routing key: ${result.reason}`),
				)
			}
		})

		const createDestination: AlertDestinationsServiceShape["createDestination"] = Effect.fn(
			"AlertsService.createDestination",
		)(function* (orgId, userId, roles, request) {
			yield* requireAdmin(roles)
			if (request.type === "webhook") yield* validateDestinationUrl(request.url, "url")
			else if (request.type === "discord") {
				yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
			}
			const destinationId = decodeAlertDestinationIdSync(runtime.makeUuid())
			let publicConfig: DestinationPublicConfig
			let secretConfig: DestinationSecretConfig
			if (request.type === "email") {
				const members = yield* resolveEmailMembers(orgId, request.memberUserIds)
				publicConfig = emailPublicConfig(members)
				secretConfig = emailSecretConfig(members)
			} else {
				publicConfig = buildPublicConfig(request)
				secretConfig =
					request.type === "hazel-oauth"
						? yield* hazelOAuth
								.createChannelWebhook(orgId, {
									channelId: request.hazelChannelId.trim(),
									name: request.name.trim(),
								})
								.pipe(
									Effect.map((webhook) => ({
										type: "hazel-oauth" as const,
										hazelOrganizationId: request.hazelOrganizationId.trim(),
										hazelOrganizationName: request.hazelOrganizationName.trim(),
										hazelChannelId: request.hazelChannelId.trim(),
										hazelChannelName: request.hazelChannelName.trim(),
										webhookId: webhook.id,
										webhookUrl: webhook.webhookUrl,
										webhookToken: webhook.token,
									})),
								)
						: buildSecretConfig(request)
			}
			if (secretConfig.type === "pagerduty") yield* validatePagerDutyKey(secretConfig.integrationKey)
			const encryptedSecret = yield* encryptSecret(
				JSON.stringify(secretConfig),
				encryptionKey,
				destinationId,
			)
			const timestamp = yield* runtime.now
			const row = {
				id: destinationId,
				orgId,
				name: request.name.trim(),
				type: request.type,
				enabled: request.enabled !== false,
				configJson: publicConfig,
				secretCiphertext: encryptedSecret.ciphertext,
				secretIv: encryptedSecret.iv,
				secretTag: encryptedSecret.tag,
				lastTestedAt: null,
				lastTestError: null,
				createdAt: new Date(timestamp),
				updatedAt: new Date(timestamp),
				createdBy: userId,
				updatedBy: userId,
			}
			const writeRows = yield* dbExecute((db) =>
				db.insert(alertDestinations).values(row).returning(txidColumn),
			)
			const txid = readTxid(writeRows)
			const document = destinationDocumentFromRow(row, publicConfig)
			return txid === undefined ? document : new AlertDestinationDocument({ ...document, txid })
		})

		const updateDestination: AlertDestinationsServiceShape["updateDestination"] = Effect.fn(
			"AlertsService.updateDestination",
		)(function* (orgId, userId, roles, destinationId, request) {
			yield* requireAdmin(roles)
			const existing = yield* requireDestinationRow(orgId, destinationId)
			if (existing.type !== request.type) {
				return yield* Effect.fail(makeValidationError("Destination type cannot be changed"))
			}
			const hydrated = yield* delivery.hydrateDestination(existing)
			if (request.type === "webhook" && request.url != null && request.url.trim().length > 0) {
				yield* validateDestinationUrl(request.url, "url")
			} else if (
				request.type === "discord" &&
				request.webhookUrl != null &&
				request.webhookUrl.trim().length > 0
			) {
				yield* validateDestinationUrl(request.webhookUrl, "webhookUrl")
			}

			const { nextPublicConfig, nextSecretConfig } = yield* Match.value(request).pipe(
				Match.discriminatorsExhaustive("type")({
					"slack-bot": (r) => {
						const channelName = normalizeOptionalString(r.channelName)
						return Effect.succeed({
							nextPublicConfig: {
								summary:
									channelName != null ? `#${channelName}` : hydrated.publicConfig.summary,
								channelLabel:
									channelName != null
										? `#${channelName}`
										: hydrated.publicConfig.channelLabel,
							} satisfies DestinationPublicConfig,
							nextSecretConfig: {
								type: "slack-bot" as const,
								channelId:
									normalizeOptionalString(r.channelId) ??
									(hydrated.secretConfig.type === "slack-bot"
										? hydrated.secretConfig.channelId
										: ""),
								channelName:
									r.channelName === undefined
										? hydrated.secretConfig.type === "slack-bot"
											? hydrated.secretConfig.channelName
											: null
										: channelName,
							} satisfies DestinationSecretConfig,
						})
					},
					pagerduty: (r) =>
						Effect.succeed({
							nextPublicConfig: hydrated.publicConfig,
							nextSecretConfig: {
								type: "pagerduty" as const,
								integrationKey:
									normalizeOptionalString(r.integrationKey) ??
									(hydrated.secretConfig.type === "pagerduty"
										? hydrated.secretConfig.integrationKey
										: ""),
							} satisfies DestinationSecretConfig,
						}),
					webhook: (r) =>
						Effect.succeed({
							nextPublicConfig: {
								summary:
									r.url != null && r.url.trim().length > 0
										? summarizeWebhookUrl(r.url)
										: hydrated.publicConfig.summary,
								channelLabel: null,
							} satisfies DestinationPublicConfig,
							nextSecretConfig: {
								type: "webhook" as const,
								url:
									normalizeOptionalString(r.url) ??
									(hydrated.secretConfig.type === "webhook"
										? hydrated.secretConfig.url
										: ""),
								signingSecret:
									r.signingSecret === undefined
										? hydrated.secretConfig.type === "webhook"
											? hydrated.secretConfig.signingSecret
											: null
										: normalizeOptionalString(r.signingSecret),
							} satisfies DestinationSecretConfig,
						}),
					"hazel-oauth": (r) =>
						Effect.gen(function* () {
							const previousSecret =
								hydrated.secretConfig.type === "hazel-oauth" ? hydrated.secretConfig : null
							const nextOrganizationId =
								normalizeOptionalString(r.hazelOrganizationId) ??
								previousSecret?.hazelOrganizationId ??
								""
							const nextOrganizationName =
								normalizeOptionalString(r.hazelOrganizationName) ??
								previousSecret?.hazelOrganizationName ??
								""
							const nextOrganizationLogoUrl =
								r.hazelOrganizationLogoUrl === undefined
									? (hydrated.publicConfig.hazelOrganizationLogoUrl ?? null)
									: r.hazelOrganizationLogoUrl
							const nextChannelId =
								normalizeOptionalString(r.hazelChannelId) ??
								previousSecret?.hazelChannelId ??
								""
							const nextChannelName =
								normalizeOptionalString(r.hazelChannelName) ??
								previousSecret?.hazelChannelName ??
								""
							const nextName = normalizeOptionalString(r.name) ?? existing.name
							const channelChanged =
								previousSecret == null || previousSecret.hazelChannelId !== nextChannelId
							const provisioned = channelChanged
								? yield* hazelOAuth.createChannelWebhook(orgId, {
										channelId: nextChannelId,
										name: nextName,
									})
								: null
							return {
								nextPublicConfig: {
									summary: `${nextOrganizationName} · #${nextChannelName}`,
									channelLabel: `#${nextChannelName}`,
									hazelOrganizationId: nextOrganizationId,
									hazelOrganizationName: nextOrganizationName,
									hazelOrganizationLogoUrl: nextOrganizationLogoUrl,
									hazelChannelId: nextChannelId,
									hazelChannelName: nextChannelName,
								} satisfies DestinationPublicConfig,
								nextSecretConfig: {
									type: "hazel-oauth" as const,
									hazelOrganizationId: nextOrganizationId,
									hazelOrganizationName: nextOrganizationName,
									hazelChannelId: nextChannelId,
									hazelChannelName: nextChannelName,
									webhookId: provisioned?.id ?? previousSecret!.webhookId,
									webhookUrl: provisioned?.webhookUrl ?? previousSecret!.webhookUrl,
									webhookToken: provisioned?.token ?? previousSecret!.webhookToken,
								} satisfies DestinationSecretConfig,
							}
						}),
					discord: (r) =>
						Effect.succeed({
							nextPublicConfig: {
								summary:
									r.webhookUrl != null && r.webhookUrl.trim().length > 0
										? summarizeWebhookUrl(r.webhookUrl)
										: hydrated.publicConfig.summary,
								channelLabel: null,
							} satisfies DestinationPublicConfig,
							nextSecretConfig: {
								type: "discord" as const,
								webhookUrl:
									normalizeOptionalString(r.webhookUrl) ??
									(hydrated.secretConfig.type === "discord"
										? hydrated.secretConfig.webhookUrl
										: ""),
							} satisfies DestinationSecretConfig,
						}),
					email: (r) =>
						Effect.gen(function* () {
							const supplied =
								r.memberUserIds != null && r.memberUserIds.length > 0 ? r.memberUserIds : null
							if (supplied === null) {
								return {
									nextPublicConfig: hydrated.publicConfig,
									nextSecretConfig:
										hydrated.secretConfig.type === "email"
											? hydrated.secretConfig
											: emailSecretConfig([]),
								}
							}
							const members = yield* resolveEmailMembers(orgId, supplied)
							return {
								nextPublicConfig: emailPublicConfig(members),
								nextSecretConfig: emailSecretConfig(members),
							}
						}),
				}),
			)
			if (
				request.type === "pagerduty" &&
				normalizeOptionalString(request.integrationKey) != null &&
				nextSecretConfig.type === "pagerduty"
			) {
				yield* validatePagerDutyKey(nextSecretConfig.integrationKey)
			}
			const encryptedSecret = yield* encryptSecret(
				JSON.stringify(nextSecretConfig),
				encryptionKey,
				destinationId,
			)
			const timestamp = yield* runtime.now
			const nextName = normalizeOptionalString(request.name) ?? existing.name
			const nextEnabled = request.enabled === undefined ? existing.enabled : request.enabled
			const writeRows = yield* dbExecute((db) =>
				db
					.update(alertDestinations)
					.set({
						name: nextName,
						enabled: nextEnabled,
						configJson: nextPublicConfig,
						secretCiphertext: encryptedSecret.ciphertext,
						secretIv: encryptedSecret.iv,
						secretTag: encryptedSecret.tag,
						updatedAt: new Date(timestamp),
						updatedBy: userId,
					})
					.where(and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)))
					.returning(txidColumn),
			)
			const txid = readTxid(writeRows)
			const document = yield* rowToDestinationDocument(
				{
					...existing,
					name: nextName,
					enabled: nextEnabled,
					configJson: nextPublicConfig,
					secretCiphertext: encryptedSecret.ciphertext,
					secretIv: encryptedSecret.iv,
					secretTag: encryptedSecret.tag,
					updatedAt: new Date(timestamp),
					updatedBy: userId,
				},
				nextPublicConfig,
			)
			return txid === undefined ? document : new AlertDestinationDocument({ ...document, txid })
		})

		const deleteDestination: AlertDestinationsServiceShape["deleteDestination"] = Effect.fn(
			"AlertsService.deleteDestination",
		)(function* (orgId, roles, destinationId) {
			yield* requireAdmin(roles)
			yield* requireDestinationRow(orgId, destinationId)
			const dependentRules = yield* dbExecute((db) =>
				db
					.select({
						id: alertRules.id,
						name: alertRules.name,
						destinationIdsJson: alertRules.destinationIdsJson,
					})
					.from(alertRules)
					.where(eq(alertRules.orgId, orgId)),
			)
			const decodedRules = yield* Effect.forEach(dependentRules, (row) =>
				decodeStoredAlertRuleDestinationIds(row.id, row.destinationIdsJson).pipe(
					Effect.map((destinationIds) => ({ row, destinationIds })),
				),
			)
			const referencedByRules = decodedRules.filter(({ destinationIds }) =>
				destinationIds.includes(destinationId),
			)
			if (referencedByRules.length > 0) {
				const ruleIds = referencedByRules.map(({ row }) => decodeAlertRuleIdSync(row.id))
				const ruleNames = referencedByRules.map(({ row }) => row.name)
				return yield* Effect.fail(
					new AlertDestinationInUseError({
						message: `Destination is still used by alert rules: ${ruleNames.join(", ")}`,
						destinationId,
						ruleIds,
						ruleNames,
					}),
				)
			}
			const deleted = yield* dbExecute((db) =>
				db
					.delete(alertDestinations)
					.where(and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.id, destinationId)))
					.returning(txidColumn),
			)
			const txid = readTxid(deleted)
			return new AlertDestinationDeleteResponse({
				id: destinationId,
				...(txid !== undefined && { txid }),
			})
		})

		const testDestination: AlertDestinationsServiceShape["testDestination"] = Effect.fn(
			"AlertsService.testDestination",
		)(function* (orgId, _userId, roles, destinationId) {
			yield* requireAdmin(roles)
			const row = yield* requireDestinationRow(orgId, destinationId)
			yield* delivery
				.sendImmediateNotification(row, {
					deliveryKey: `${orgId}:${destinationId}:test`,
					ruleId: decodeAlertRuleIdSync(runtime.makeUuid()),
					ruleName: "Test alert",
					groupKey: null,
					signalType: "throughput",
					severity: "warning",
					comparator: "lt",
					threshold: 1,
					thresholdUpper: null,
					windowMinutes: 5,
					eventType: "test",
					incidentId: null,
					incidentStatus: "resolved",
					dedupeKey: `${orgId}:${destinationId}:test`,
					value: 0,
					sampleCount: 0,
					linkUrl: delivery.composeLinkUrl(null),
					sentAtMs: yield* runtime.now,
				})
				.pipe(
					Effect.tapError((error) =>
						markDestinationTest(
							orgId,
							destinationId,
							error instanceof Error ? error.message : "Destination test failed",
						),
					),
				)
			yield* markDestinationTest(orgId, destinationId, null)
			return new AlertDestinationTestResponse({
				success: true,
				message: "Test notification sent",
			})
		})

		return {
			listDestinations,
			createDestination,
			updateDestination,
			deleteDestination,
			testDestination,
		} satisfies AlertDestinationsServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(SlackBotTokenResolver.layer))
}
