import { RoleName, UserId as UserIdSchema, type OrgId } from "@maple/domain/http"
import { orgClickHouseSettings, orgIngestKeys } from "@maple/db"
import * as CH from "@maple/query-engine/ch"
import { Clock, Cause, Context, Effect, Layer, Schema } from "effect"
import type { TenantContext } from "@/services/auth/AuthService"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"

import { formatWarehouseDateTime } from "@maple/query-engine"
import { summarizeCause } from "@/platform/describe-cause"
const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)

const HOUR_MS = 3_600_000

/**
 * How many completed hours back the rollup re-checks on every run. Bounds the
 * per-run cost to a constant and lets a few missed cron ticks catch up. Hours
 * already present in `service_map_edges_hourly` are skipped; an hour with
 * genuinely zero cross-service calls is re-attempted each run until it ages out
 * of this window.
 *
 * That re-attempt is NOT free — the join is empty only *after* it has scanned
 * the hour's spans. Keep the org set gated (see `resolveActiveOrgs`): when the
 * rollup fanned out across every org that ever held an ingest key, this window
 * turned ~260 orgs into ~6 executions each per tick, of two queries, one of
 * them a raw-`traces` self-join.
 */
const LOOKBACK_HOURS = 6

/**
 * Discovery window for the active-org scan. Must be a SUPERSET of the per-org
 * lookback so no org that produced spans in a candidate hour is skipped.
 */
const ACTIVE_DISCOVERY_HOURS = LOOKBACK_HOURS + 2

/** Concurrency for per-org rollup processing. */
const ORG_CONCURRENCY = 4

interface ServiceMapRollupResult {
	readonly orgsProcessed: number
	readonly hoursRolledUp: number
	readonly edgesWritten: number
	readonly resolutionsWritten: number
	readonly resolutionHoursChecked: number
	readonly emptyResolutionHours: number
	readonly orgFailures: number
}

export interface ServiceMapRollupServiceApi {
	/**
	 * Aggregate service-to-service edges for any completed hour in the trailing
	 * `LOOKBACK_HOURS` window not yet present in `service_map_edges_hourly`, and
	 * ingest them. Per-org failures are logged and counted, never thrown.
	 */
	readonly runRollupTick: () => Effect.Effect<ServiceMapRollupResult, DatabaseError>
}

/**
 * Scheduled hourly rollup for the service map's service-to-service edges.
 *
 * The edge itself cannot be computed by a materialized view: its downstream
 * service is only recoverable by joining a Client/Producer span to its child
 * Server/Consumer span (modern OTEL instrumentation no longer emits a
 * `peer.service` attribute). This service runs that join — `serviceMapEdgesRollupSQL`
 * — once per completed hour and ingests the pre-aggregated result through the
 * Events API bridge, so the dashboard read path (`serviceDependenciesSQL`)
 * stays cheap.
 */
export class ServiceMapRollupService extends Context.Service<
	ServiceMapRollupService,
	ServiceMapRollupServiceApi
>()("@maple/api/services/ServiceMapRollupService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: decodeUserIdSync("system-service-map-rollup"),
			roles: [decodeRoleNameSync("root")],
			authMode: "self_hosted",
		})

		const processOrg = Effect.fn("ServiceMapRollupService.processOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			const tenant = systemTenant(orgId)
			const currentHourMs = Math.floor((yield* Clock.currentTimeMillis) / HOUR_MS) * HOUR_MS
			const oldestHourMs = currentHourMs - LOOKBACK_HOURS * HOUR_MS

			// Completed hour starts in the lookback window, oldest → newest.
			const candidates: number[] = []
			for (let h = oldestHourMs; h < currentHourMs; h += HOUR_MS) candidates.push(h)

			const existingCompiled = CH.serviceMapEdgesExistingHoursSQL({
				orgId,
				startTime: formatWarehouseDateTime(oldestHourMs),
				endTime: formatWarehouseDateTime(currentHourMs),
			})
			const existingRows = yield* warehouse.compiledQuery(tenant, existingCompiled, {
				context: "serviceMapRollupExistingHours",
			})
			const existing = new Set(existingRows.map((row) => Number(row.hourTs)))

			const missing = candidates.filter((hourMs) => !existing.has(Math.floor(hourMs / 1000)))

			let hoursRolledUp = 0
			let edgesWritten = 0
			let resolutionsWritten = 0
			let resolutionHoursChecked = 0
			let emptyResolutionHours = 0
			yield* Effect.forEach(
				missing,
				(hourMs) =>
					Effect.gen(function* () {
						const hourStart = formatWarehouseDateTime(hourMs)
						const hourEnd = formatWarehouseDateTime(hourMs + HOUR_MS)

						const rollup = CH.serviceMapEdgesRollupSQL({ orgId, hourStart, hourEnd })
						const rows = yield* warehouse.compiledQuery(tenant, rollup, {
							context: "serviceMapRollup",
						})
						if (rows.length > 0) {
							// Not metered to Autumn: derived from spans that were already billed
							// on arrival at the ingest gateway.
							yield* warehouse.ingest(tenant, "service_map_edges_hourly_ingest", rows)
							edgesWritten += rows.length
						}

						// Companion write: address-resolutions, used by the external-edges
						// query's anti-join to suppress internal-service overlap. Separate
						// SQL pass (~same cost as the edges JOIN) so the existing rollup
						// query keeps its tight shape; failure of one ingest doesn't
						// invalidate the other (per-org Effect failure already isolated).
						//
						// A bounded repair pass below re-evaluates this companion stream
						// for already-sealed edge hours, so a transient ingest failure does
						// not leave a permanent address-resolution gap.
						const resolutionsRollup = CH.serviceMapResolutionsRollupSQL({
							orgId,
							hourStart,
							hourEnd,
						})
						const resolutionsRows = yield* warehouse.compiledQuery(tenant, resolutionsRollup, {
							context: "serviceMapResolutionsRollup",
						})
						resolutionHoursChecked += 1
						if (resolutionsRows.length > 0) {
							yield* warehouse.ingest(
								tenant,
								"service_address_resolutions_hourly",
								resolutionsRows,
							)
							resolutionsWritten += resolutionsRows.length
						} else {
							emptyResolutionHours += 1
						}
						hoursRolledUp += 1
					}),
				{ discard: true },
			)

			// Edge rows are the seal for an hour, but the companion resolution
			// ingest can fail independently. Recompute resolution rows for sealed
			// hours in the bounded lookback as an idempotent repair pass
			// (ReplacingMergeTree deduplicates the same mapping key).
			//
			// Only for hours that have no resolution rows yet: the repair join
			// reads raw `traces`, so re-running it for every sealed hour on every
			// tick was the single most expensive thing this service did.
			const resolvedRows = yield* warehouse.compiledQuery(
				tenant,
				CH.serviceMapResolutionsExistingHoursSQL({
					orgId,
					startTime: formatWarehouseDateTime(oldestHourMs),
					endTime: formatWarehouseDateTime(currentHourMs),
				}),
				{ context: "serviceMapResolutionsExistingHours" },
			)
			const resolved = new Set(resolvedRows.map((row) => Number(row.hourTs)))

			yield* Effect.forEach(
				candidates.filter(
					(hourMs) =>
						existing.has(Math.floor(hourMs / 1000)) && !resolved.has(Math.floor(hourMs / 1000)),
				),
				(hourMs) =>
					Effect.gen(function* () {
						const resolutionsRows = yield* warehouse.compiledQuery(
							tenant,
							CH.serviceMapResolutionsRollupSQL({
								orgId,
								hourStart: formatWarehouseDateTime(hourMs),
								hourEnd: formatWarehouseDateTime(hourMs + HOUR_MS),
							}),
							{ context: "serviceMapResolutionsRepair" },
						)
						resolutionHoursChecked += 1
						if (resolutionsRows.length === 0) {
							emptyResolutionHours += 1
							return
						}
						yield* warehouse.ingest(tenant, "service_address_resolutions_hourly", resolutionsRows)
						resolutionsWritten += resolutionsRows.length
					}),
				{ discard: true },
			)
			return {
				hoursRolledUp,
				edgesWritten,
				resolutionsWritten,
				resolutionHoursChecked,
				emptyResolutionHours,
				failed: false,
			}
		})

		/**
		 * Which orgs actually produced spans in the discovery window.
		 *
		 * One cross-org scan of `traces_aggregates_hourly` replaces per-org
		 * guessing — the same gating the error-issue and anomaly ticks already
		 * use (`packages/query-engine/src/ch/queries/activity.ts`). Idle orgs
		 * have no spans to join, so every hour they are handed costs two
		 * warehouse scans to prove a join is empty.
		 *
		 * BYO-ClickHouse orgs are invisible to this managed-workspace scan and
		 * are always processed.
		 *
		 * Fails OPEN, unlike the anomaly tick: a skipped rollup hour is a
		 * permanent gap in the service map once it ages past `LOOKBACK_HOURS`,
		 * whereas a skipped anomaly evaluation is only a late alert. A discovery
		 * outage costs one hour of the old fan-out; failing closed could cost
		 * the edges outright.
		 */
		const resolveActiveOrgs = Effect.fn("ServiceMapRollupService.resolveActiveOrgs")(function* (
			knownOrgs: ReadonlyArray<OrgId>,
		) {
			if (knownOrgs.length === 0) return undefined

			const nowMs = yield* Clock.currentTimeMillis
			const startTime = formatWarehouseDateTime(nowMs - ACTIVE_DISCOVERY_HOURS * HOUR_MS)
			const byoRows = yield* database
				.execute((db) =>
					db.selectDistinct({ orgId: orgClickHouseSettings.orgId }).from(orgClickHouseSettings),
				)
				.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ orgId: OrgId }>))

			return yield* warehouse
				.crossOrgQuery(
					systemTenant(knownOrgs[0]!),
					CH.compile(
						CH.activeOrgsByTracesQuery(),
						{ startTime },
						{ rowSchema: CH.ActiveOrgsOutputSchema },
					),
					{
						profile: "discovery",
						context: "serviceMapRollupActiveOrgs",
						justification:
							"enumerate orgs with recent span aggregates so the hourly service-map rollup skips idle orgs",
					},
				)
				.pipe(
					Effect.map((rows) => {
						const active = new Set<OrgId>(byoRows.map((row) => row.orgId))
						for (const row of rows) {
							active.add(row.orgId)
						}
						return active as ReadonlySet<OrgId>
					}),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.as(
									Effect.logWarning(
										"Service map rollup active-org discovery failed; processing every known org",
									).pipe(Effect.annotateLogs({ error: summarizeCause(cause) })),
									undefined,
								),
					),
				)
		})

		const runRollupTick: ServiceMapRollupServiceApi["runRollupTick"] = Effect.fn(
			"ServiceMapRollupService.runRollupTick",
		)(function* () {
			const orgRows = yield* database.execute((db) =>
				db.selectDistinct({ orgId: orgIngestKeys.orgId }).from(orgIngestKeys),
			)

			const knownOrgs = orgRows.map((row) => row.orgId)
			const active = yield* resolveActiveOrgs(knownOrgs)
			const targetOrgs =
				active === undefined ? knownOrgs : knownOrgs.filter((orgId) => active.has(orgId))
			yield* Effect.annotateCurrentSpan({
				knownOrgs: knownOrgs.length,
				targetOrgs: targetOrgs.length,
				activeOrgDiscovery: active === undefined ? "failed" : "ok",
			})

			const results = yield* Effect.forEach(
				targetOrgs,
				(orgId) =>
					processOrg(orgId).pipe(
						// Interrupts (isolate teardown) are NOT failures — re-raise them
						// so the tick cancels promptly instead of logging phantom
						// per-org failures.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.as(
										Effect.logError("Service map rollup failed for org").pipe(
											Effect.annotateLogs({
												orgId,
												error: summarizeCause(cause),
											}),
										),
										{
											hoursRolledUp: 0,
											edgesWritten: 0,
											resolutionsWritten: 0,
											resolutionHoursChecked: 0,
											emptyResolutionHours: 0,
											failed: true,
										},
									),
						),
					),
				{ concurrency: ORG_CONCURRENCY },
			)

			return {
				orgsProcessed: targetOrgs.length,
				hoursRolledUp: results.reduce((sum, r) => sum + r.hoursRolledUp, 0),
				edgesWritten: results.reduce((sum, r) => sum + r.edgesWritten, 0),
				resolutionsWritten: results.reduce((sum, r) => sum + r.resolutionsWritten, 0),
				resolutionHoursChecked: results.reduce((sum, r) => sum + r.resolutionHoursChecked, 0),
				emptyResolutionHours: results.reduce((sum, r) => sum + r.emptyResolutionHours, 0),
				orgFailures: results.filter((r) => r.failed).length,
			}
		})

		return { runRollupTick }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
