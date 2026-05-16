import { RoleName, UserId as UserIdSchema, type OrgId } from "@maple/domain/http"
import { orgIngestKeys } from "@maple/db"
import * as CH from "@maple/query-engine/ch"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import type { TenantContext } from "./AuthService"
import { Database, type DatabaseError } from "./DatabaseLive"
import { WarehouseQueryService } from "./WarehouseQueryService"

const decodeRoleNameSync = Schema.decodeUnknownSync(RoleName)
const decodeUserIdSync = Schema.decodeUnknownSync(UserIdSchema)

const HOUR_MS = 3_600_000

/**
 * How many completed hours back the rollup re-checks on every run. Bounds the
 * per-run cost to a constant and lets a few missed cron ticks catch up. Hours
 * already present in `service_map_edges_hourly` are skipped, so re-checking is
 * cheap; an hour with genuinely zero cross-service calls is re-attempted each
 * run until it ages out of this window — also cheap (an empty join).
 */
const LOOKBACK_HOURS = 6

/** Concurrency for per-org rollup processing. */
const ORG_CONCURRENCY = 4

export interface ServiceMapRollupResult {
	readonly orgsProcessed: number
	readonly hoursRolledUp: number
	readonly edgesWritten: number
	readonly orgFailures: number
}

export interface ServiceMapRollupServiceShape {
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
 * `service_map_edges_hourly` cannot be filled by a materialized view: an edge's
 * downstream service is only recoverable by joining a Client/Producer span to
 * its child Server/Consumer span (modern OTEL instrumentation no longer emits a
 * `peer.service` attribute). This service runs that join — `serviceMapEdgesRollupSQL`
 * — once per completed hour and ingests the pre-aggregated result, so the
 * dashboard read path (`serviceDependenciesSQL`) stays cheap.
 */
export class ServiceMapRollupService extends Context.Service<
	ServiceMapRollupService,
	ServiceMapRollupServiceShape
>()("ServiceMapRollupService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const warehouse = yield* WarehouseQueryService

		const systemTenant = (orgId: OrgId): TenantContext => ({
			orgId,
			userId: decodeUserIdSync("system-service-map-rollup"),
			roles: [decodeRoleNameSync("root")],
			authMode: "self_hosted",
		})

		const toTinybirdDateTime = (epochMs: number) =>
			new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")

		const processOrg = Effect.fn("ServiceMapRollupService.processOrg")(function* (orgId: OrgId) {
			const tenant = systemTenant(orgId)
			const currentHourMs = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
			const oldestHourMs = currentHourMs - LOOKBACK_HOURS * HOUR_MS

			// Completed hour starts in the lookback window, oldest → newest.
			const candidates: number[] = []
			for (let h = oldestHourMs; h < currentHourMs; h += HOUR_MS) candidates.push(h)

			const existingCompiled = CH.serviceMapEdgesExistingHoursSQL({
				orgId,
				startTime: toTinybirdDateTime(oldestHourMs),
				endTime: toTinybirdDateTime(currentHourMs),
			})
			const existingRaw = yield* warehouse.sqlQuery(tenant, existingCompiled.sql, {
				context: "serviceMapRollupExistingHours",
			})
			const existing = new Set(
				existingCompiled.castRows(existingRaw).map((row) => Number(row.hourTs)),
			)

			const missing = candidates.filter((hourMs) => !existing.has(Math.floor(hourMs / 1000)))

			let hoursRolledUp = 0
			let edgesWritten = 0
			for (const hourMs of missing) {
				const rollup = CH.serviceMapEdgesRollupSQL({
					orgId,
					hourStart: toTinybirdDateTime(hourMs),
					hourEnd: toTinybirdDateTime(hourMs + HOUR_MS),
				})
				const raw = yield* warehouse.sqlQuery(tenant, rollup.sql, {
					context: "serviceMapRollup",
				})
				const rows = rollup.castRows(raw)
				if (rows.length > 0) {
					yield* warehouse.ingest(tenant, "service_map_edges_hourly", rows)
					edgesWritten += rows.length
				}
				hoursRolledUp += 1
			}
			return { hoursRolledUp, edgesWritten, failed: false }
		})

		const runRollupTick: ServiceMapRollupServiceShape["runRollupTick"] = Effect.fn(
			"ServiceMapRollupService.runRollupTick",
		)(function* () {
			const orgRows = yield* database.execute((db) =>
				db.selectDistinct({ orgId: orgIngestKeys.orgId }).from(orgIngestKeys),
			)

			const results = yield* Effect.forEach(
				orgRows,
				(row) =>
					processOrg(row.orgId as OrgId).pipe(
						Effect.catchCause((cause) =>
							Effect.as(
								Effect.logError("Service map rollup failed for org").pipe(
									Effect.annotateLogs({
										orgId: row.orgId,
										error: Cause.pretty(cause),
									}),
								),
								{ hoursRolledUp: 0, edgesWritten: 0, failed: true },
							),
						),
					),
				{ concurrency: ORG_CONCURRENCY },
			)

			return {
				orgsProcessed: orgRows.length,
				hoursRolledUp: results.reduce((sum, r) => sum + r.hoursRolledUp, 0),
				edgesWritten: results.reduce((sum, r) => sum + r.edgesWritten, 0),
				orgFailures: results.filter((r) => r.failed).length,
			}
		})

		return { runRollupTick }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer
}
