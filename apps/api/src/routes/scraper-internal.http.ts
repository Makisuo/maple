import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import {
	InternalScrapeTarget,
	OrgId,
	ScrapeIntervalSeconds,
	ScrapeResultReportList,
	ScrapeTargetId,
	UserId,
} from "@maple/domain/http"
import { Env } from "../lib/Env"
import { isValidInternalBearer } from "../lib/internal-auth"
import { OrgIngestKeysService } from "../services/OrgIngestKeysService"
import {
	PlanetScaleDiscoveryService,
	type PlanetScaleSubTarget,
} from "../services/PlanetScaleDiscoveryService"
import { ScrapeTargetsService } from "../services/ScrapeTargetsService"

const decodeTargetIdSync = Schema.decodeUnknownSync(ScrapeTargetId)
const decodeOrgIdSync = Schema.decodeUnknownSync(OrgId)
const decodeScrapeIntervalSecondsSync = Schema.decodeUnknownSync(ScrapeIntervalSeconds)

/** Audit identity for lazily-created ingest keys (org_ingest_keys.created_by). */
const SCRAPER_SYSTEM_USER = Schema.decodeUnknownSync(UserId)("system-prometheus-scraper")
const decodeScrapeResultsEffect = Schema.decodeUnknownEffect(ScrapeResultReportList)
const decodeLabelsEffect = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

export interface ScrapeTargetRowLike {
	readonly id: string
	readonly orgId: string
	readonly name: string
	readonly serviceName: string | null
	readonly url: string
	readonly scrapeIntervalSeconds: number
	readonly labelsJson: Record<string, string> | null
}

export interface SubTargetOverride {
	/** Discovered per-branch scrape URL replacing the row's SD endpoint url. */
	readonly url: string
	readonly subTargetKey: string
	/** Discovery labels; the target's own labelsJson wins on key conflicts. */
	readonly labels: Record<string, string>
}

/**
 * Marshal a DB row into the internal wire shape. Unparseable labels degrade
 * to `{}`; a row that fails the schema brands (interval out of range, bad id)
 * yields `none` so one corrupt row cannot break the whole list. Discovered
 * sub-targets (PlanetScale branches) pass an override carrying the concrete
 * scrape URL and discriminator key.
 */
export const toInternalScrapeTarget = (
	row: ScrapeTargetRowLike,
	ingestKey: string,
	subTarget?: SubTargetOverride,
): Effect.Effect<Option.Option<InternalScrapeTarget>> =>
	Effect.gen(function* () {
		const ownLabels = row.labelsJson
			? yield* decodeLabelsEffect(row.labelsJson).pipe(
					Effect.orElseSucceed(() => ({}) as Record<string, string>),
				)
			: {}
		const labels = subTarget ? { ...subTarget.labels, ...ownLabels } : ownLabels
		return yield* Effect.try({
			try: () =>
				new InternalScrapeTarget({
					id: decodeTargetIdSync(row.id),
					orgId: row.orgId,
					name: row.name,
					serviceName: row.serviceName ?? null,
					url: subTarget?.url ?? row.url,
					subTargetKey: subTarget?.subTargetKey ?? null,
					scrapeIntervalSeconds: decodeScrapeIntervalSecondsSync(row.scrapeIntervalSeconds),
					labels,
					ingestKey,
				}),
			catch: () => new Error("invalid scrape target row"),
		}).pipe(Effect.option)
	})

/**
 * Internal endpoints backing the standalone Prometheus scraper
 * (apps/scraper). The scraper polls `/api/internal/scrape-targets` for the
 * enabled target list, fetches each target's exposition text through
 * `/api/internal/prometheus-scrape` (credentials stay server-side), and
 * reports outcomes to `/api/internal/scrape-results`.
 */
export const ScraperInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* ScrapeTargetsService
		const ingestKeys = yield* OrgIngestKeysService
		const discovery = yield* PlanetScaleDiscoveryService
		const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const unauthorized = (req: HttpServerRequest.HttpServerRequest) => {
			if (!internalToken) return errorText("Scraper internal endpoints are not configured", 401)
			if (!isValidInternalBearer(req.headers.authorization, internalToken)) {
				return errorText("Unauthorized", 401)
			}
			return undefined
		}

		const listTargets = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const denied = unauthorized(req)
				if (denied) return denied

				const rows = yield* service.listAllEnabled()

				// One public ingest key per org (lazily created on first use, like
				// onboarding does). The scraper ingests with this key so scraped
				// metrics are billed and warehouse-routed identically to the org's
				// own OTLP traffic.
				const keyByOrg = new Map<string, string | null>()
				const ingestKeyForOrg = (orgId: string) =>
					Effect.gen(function* () {
						const cached = keyByOrg.get(orgId)
						if (cached !== undefined) return cached
						const key: string = yield* ingestKeys
							.getOrCreate(decodeOrgIdSync(orgId), SCRAPER_SYSTEM_USER)
							.pipe(Effect.map((keys) => keys.publicKey))
						keyByOrg.set(orgId, key)
						return key
					})

				const targets: Array<InternalScrapeTarget> = []
				yield* Effect.forEach(rows, (row) =>
					Effect.gen(function* () {
						const ingestKey = yield* ingestKeyForOrg(row.orgId)
						if (ingestKey === null) {
							yield* Effect.logWarning("Skipping scrape target (no ingest key)").pipe(
								Effect.annotateLogs({ scrapeTargetId: row.id, orgId: row.orgId }),
							)
							return
						}

						if (row.targetType === "planetscale") {
							// Expand the logical target into its discovered per-branch
							// endpoints. Discovery failure with no cache skips the row this
							// round; the scheduler re-fetches the list every reconcile.
							const subTargets = yield* discovery.discover(row).pipe(
								Effect.catch((error) =>
									Effect.logWarning("Skipping PlanetScale target (discovery failed)").pipe(
										Effect.annotateLogs({
											scrapeTargetId: row.id,
											orgId: row.orgId,
											error: error.message,
										}),
										Effect.as([] as ReadonlyArray<PlanetScaleSubTarget>),
									),
								),
							)
							yield* Effect.forEach(subTargets, (subTarget) =>
								Effect.gen(function* () {
									const target = yield* toInternalScrapeTarget(row, ingestKey, subTarget)
									if (Option.isSome(target)) {
										targets.push(target.value)
									} else {
										yield* Effect.logWarning(
											"Skipping scrape sub-target (invalid row)",
										).pipe(
											Effect.annotateLogs({
												scrapeTargetId: row.id,
												orgId: row.orgId,
												subTargetKey: subTarget.subTargetKey,
											}),
										)
									}
								}),
							)
							return
						}

						const target = yield* toInternalScrapeTarget(row, ingestKey)
						if (Option.isSome(target)) {
							targets.push(target.value)
						} else {
							yield* Effect.logWarning("Skipping scrape target (invalid row)").pipe(
								Effect.annotateLogs({ scrapeTargetId: row.id, orgId: row.orgId }),
							)
						}
					}),
				)

				return yield* HttpServerResponse.json(targets)
			}).pipe(
				Effect.catch((error) =>
					Effect.logError("Failed to build scraper target list").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(errorText("Scraper target list unavailable", 503)),
					),
				),
				Effect.withSpan("ScraperInternal.listTargets"),
			)

		const recordResults = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const denied = unauthorized(req)
				if (denied) return denied

				const body = yield* req.json.pipe(Effect.option)
				if (Option.isNone(body)) return errorText("Invalid JSON body", 400)

				const results = yield* decodeScrapeResultsEffect(body.value).pipe(Effect.option)
				if (Option.isNone(results)) return errorText("Invalid scrape results payload", 400)

				yield* service.recordScrapeResults(results.value)

				return yield* HttpServerResponse.json({ recorded: results.value.length })
			}).pipe(
				Effect.catch((error) =>
					Effect.logError("Failed to persist scrape results").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(errorText("Scrape result persistence unavailable", 503)),
					),
				),
				Effect.withSpan("ScraperInternal.recordResults"),
			)

		yield* router.add("GET", "/api/internal/scrape-targets", listTargets)
		yield* router.add("POST", "/api/internal/scrape-results", recordResults)
	}),
)
