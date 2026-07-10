import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import {
	InternalRailwayTarget,
	OrgId,
	RailwayConnectionId,
	RailwayMetricsIntervalSeconds,
	RailwayResultReportList,
	RailwayTargetId,
	RailwayTokenType,
	UserId,
} from "@maple/domain/http"
import { Env } from "../lib/Env"
import { isValidInternalBearer } from "../lib/internal-auth"
import { OrgIngestKeysService } from "../services/OrgIngestKeysService"
import { RailwayIntegrationService, type EnabledRailwayTarget } from "../services/RailwayIntegrationService"

const decodeTargetIdSync = Schema.decodeUnknownSync(RailwayTargetId)
const decodeConnectionIdSync = Schema.decodeUnknownSync(RailwayConnectionId)
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeTokenTypeSync = Schema.decodeUnknownSync(RailwayTokenType)
const decodeMetricsIntervalSync = Schema.decodeUnknownSync(RailwayMetricsIntervalSeconds)

/** Audit identity for lazily-created ingest keys (org_ingest_keys.created_by). */
const RAILWAY_SYSTEM_USER = Schema.decodeUnknownSync(UserId)("system-railway-connector")
const decodeResultsEffect = Schema.decodeUnknownEffect(RailwayResultReportList)

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

/**
 * Marshal a joined connection×target row into the internal wire shape. A row
 * whose brands fail to decode (bad id, interval out of range) yields `none`
 * so one corrupt row cannot break the whole list.
 */
export const toInternalRailwayTarget = (
	entry: EnabledRailwayTarget,
	ingestKey: string,
): Option.Option<InternalRailwayTarget> => {
	try {
		return Option.some(
			new InternalRailwayTarget({
				id: decodeTargetIdSync(entry.target.id),
				orgId: entry.target.orgId,
				connectionId: decodeConnectionIdSync(entry.connection.id),
				tokenType: decodeTokenTypeSync(entry.connection.tokenType),
				token: entry.token,
				projectId: entry.target.projectId,
				projectName: entry.target.projectName,
				environmentId: entry.target.environmentId,
				environmentName: entry.target.environmentName,
				services: entry.services.map((service) => ({ id: service.id, name: service.name })),
				logsEnabled: entry.target.logsEnabled,
				metricsEnabled: entry.target.metricsEnabled,
				metricsIntervalSeconds: decodeMetricsIntervalSync(entry.target.metricsIntervalSeconds),
				logWatermarkMs: entry.target.logWatermarkAt?.getTime() ?? null,
				metricsWatermarkMs: entry.target.metricsWatermarkAt?.getTime() ?? null,
				ingestKey,
			}),
		)
	} catch {
		return Option.none()
	}
}

/**
 * Internal endpoints backing the standalone railway-connector
 * (apps/railway-connector). The connector polls
 * `/api/internal/railway-targets` for the enabled target list (decrypted
 * Railway tokens + org ingest keys ride this internal wire only) and reports
 * outcomes to `/api/internal/railway-results`.
 */
export const RailwayInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* RailwayIntegrationService
		const ingestKeys = yield* OrgIngestKeysService
		const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const unauthorized = (req: HttpServerRequest.HttpServerRequest) => {
			if (!internalToken) return errorText("Railway internal endpoints are not configured", 401)
			if (!isValidInternalBearer(req.headers.authorization, internalToken)) {
				return errorText("Unauthorized", 401)
			}
			return undefined
		}

		const listTargets = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const denied = unauthorized(req)
				if (denied) return denied

				const entries = yield* service
					.listAllEnabledInternal()
					.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<EnabledRailwayTarget>)))

				// One public ingest key per org (lazily created on first use). The
				// connector ingests with this key so pulled logs/metrics are billed
				// and warehouse-routed identically to the org's own OTLP traffic.
				const keyByOrg = new Map<string, string | null>()
				const ingestKeyForOrg = (orgId: string) =>
					Effect.gen(function* () {
						const cached = keyByOrg.get(orgId)
						if (cached !== undefined) return cached
						const key: string | null = yield* ingestKeys
							.getOrCreate(decodeOrgIdSync(orgId), RAILWAY_SYSTEM_USER)
							.pipe(
								Effect.map((keys): string | null => keys.publicKey),
								Effect.catch(() => Effect.succeed(null)),
							)
						keyByOrg.set(orgId, key)
						return key
					})

				const targets: Array<InternalRailwayTarget> = []
				yield* Effect.forEach(entries, (entry) =>
					Effect.gen(function* () {
						const ingestKey = yield* ingestKeyForOrg(entry.target.orgId)
						if (ingestKey === null) {
							yield* Effect.logWarning("Skipping Railway target (no ingest key)").pipe(
								Effect.annotateLogs({
									railwayTargetId: entry.target.id,
									orgId: entry.target.orgId,
								}),
							)
							return
						}
						const target = toInternalRailwayTarget(entry, ingestKey)
						if (Option.isSome(target)) {
							targets.push(target.value)
						} else {
							yield* Effect.logWarning("Skipping Railway target (invalid row)").pipe(
								Effect.annotateLogs({
									railwayTargetId: entry.target.id,
									orgId: entry.target.orgId,
								}),
							)
						}
					}),
				)

				return yield* HttpServerResponse.json(targets)
			}).pipe(Effect.withSpan("RailwayInternal.listTargets"))

		const recordResults = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const denied = unauthorized(req)
				if (denied) return denied

				const body = yield* req.json.pipe(Effect.option)
				if (Option.isNone(body)) return errorText("Invalid JSON body", 400)

				const results = yield* decodeResultsEffect(body.value).pipe(Effect.option)
				if (Option.isNone(results)) return errorText("Invalid railway results payload", 400)

				yield* service
					.recordResults(results.value)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning("Failed to persist railway results").pipe(
								Effect.annotateLogs({ error: error.message }),
							),
						),
					)

				return yield* HttpServerResponse.json({ recorded: results.value.length })
			}).pipe(Effect.withSpan("RailwayInternal.recordResults"))

		yield* router.add("GET", "/api/internal/railway-targets", listTargets)
		yield* router.add("POST", "/api/internal/railway-results", recordResults)
	}),
)
