import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { ScrapeTargetResponse } from "@maple/domain/http"
import {
	CreateScrapeTargetRequest,
	CurrentTenant,
	type ScrapeTargetAuthError,
	type ScrapeTargetEncryptionError,
	type ScrapeTargetNotFoundError,
	type ScrapeTargetPersistenceError,
	type ScrapeTargetUpstreamError,
	type ScrapeTargetValidationError,
	UpdateScrapeTargetRequest,
} from "@maple/domain/http"
import {
	MapleApiV2,
	dependencyUnavailable,
	invalidRequest,
	paginateArray,
	paginateOffsetQuery,
	resourceNotFound,
	timestamp,
	upstreamError,
} from "@maple/domain/http/v2"
import type { V2ScrapeTarget, V2ScrapeTargetCheck } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { ScrapeTargetsService } from "../../services/ScrapeTargetsService"

const toV2ScrapeTarget = (target: ScrapeTargetResponse): V2ScrapeTarget => ({
	id: target.id,
	object: "scrape_target",
	name: target.name,
	service_name: target.serviceName,
	url: target.url,
	target_type: target.targetType,
	organization: target.organization,
	include_branches: target.includeBranches,
	exclude_branches: target.excludeBranches,
	scrape_interval_seconds: target.scrapeIntervalSeconds,
	labels_json: target.labelsJson,
	auth_type: target.authType,
	has_credentials: target.hasCredentials,
	managed_by: target.managedBy,
	enabled: target.enabled,
	last_scrape_at: target.lastScrapeAt,
	last_scrape_error: target.lastScrapeError,
	created_at: target.createdAt,
	updated_at: target.updatedAt,
})

/** Service tagged errors → v2 envelope errors (create: no 404 on the contract). */
const mapCommonError =
	(operation: string) =>
	<A, R>(
		effect: Effect.Effect<
			A,
			ScrapeTargetValidationError | ScrapeTargetPersistenceError | ScrapeTargetEncryptionError,
			R
		>,
	) =>
		effect.pipe(
			Effect.catchTags({
				"@maple/http/errors/ScrapeTargetValidationError": (error) =>
					Effect.fail(invalidRequest("parameter_invalid", error.message)),
				"@maple/http/errors/ScrapeTargetPersistenceError": () =>
					Effect.fail(dependencyUnavailable(`scrape_target_${operation}_unavailable`)),
				"@maple/http/errors/ScrapeTargetEncryptionError": () =>
					Effect.fail(dependencyUnavailable(`scrape_target_${operation}_unavailable`)),
			}),
		)

/** Service tagged errors → v2 envelope errors (endpoints with a 404). */
const mapMutationError =
	(operation: string) =>
	<A, R>(
		effect: Effect.Effect<
			A,
			| ScrapeTargetNotFoundError
			| ScrapeTargetValidationError
			| ScrapeTargetPersistenceError
			| ScrapeTargetEncryptionError,
			R
		>,
	) =>
		effect.pipe(
			Effect.catchTags({
				"@maple/http/errors/ScrapeTargetNotFoundError": () =>
					Effect.fail(resourceNotFound("scrape_target", "No such scrape target.")),
				"@maple/http/errors/ScrapeTargetValidationError": (error) =>
					Effect.fail(invalidRequest("parameter_invalid", error.message)),
				"@maple/http/errors/ScrapeTargetPersistenceError": () =>
					Effect.fail(dependencyUnavailable(`scrape_target_${operation}_unavailable`)),
				"@maple/http/errors/ScrapeTargetEncryptionError": () =>
					Effect.fail(dependencyUnavailable(`scrape_target_${operation}_unavailable`)),
			}),
		)

/** Probe can additionally surface upstream/auth failures as 502s. */
const mapProbeError = <A, R>(
	effect: Effect.Effect<
		A,
		| ScrapeTargetNotFoundError
		| ScrapeTargetPersistenceError
		| ScrapeTargetEncryptionError
		| ScrapeTargetAuthError
		| ScrapeTargetUpstreamError,
		R
	>,
) =>
	effect.pipe(
		Effect.catchTags({
			"@maple/http/errors/ScrapeTargetNotFoundError": () =>
				Effect.fail(resourceNotFound("scrape_target", "No such scrape target.")),
			"@maple/http/errors/ScrapeTargetPersistenceError": () =>
				Effect.fail(dependencyUnavailable("scrape_target_probe_unavailable")),
			"@maple/http/errors/ScrapeTargetEncryptionError": () =>
				Effect.fail(dependencyUnavailable("scrape_target_probe_unavailable")),
			"@maple/http/errors/ScrapeTargetAuthError": () =>
				Effect.fail(
					upstreamError(
						"scrape_target_probe_auth_failed",
						"The scrape target rejected Maple's credentials.",
					),
				),
			"@maple/http/errors/ScrapeTargetUpstreamError": () =>
				Effect.fail(
					upstreamError(
						"scrape_target_probe_upstream_failed",
						"The scrape target could not complete the probe.",
					),
				),
		}),
	)

const mapPersistenceError = () => dependencyUnavailable("scrape_target_list_unavailable")

export const HttpV2ScrapeTargetsLive = HttpApiBuilder.group(MapleApiV2, "scrapeTargets", (handlers) =>
	Effect.gen(function* () {
		const service = yield* ScrapeTargetsService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const response = yield* service
						.list(tenant.orgId)
						.pipe(Effect.mapError(mapPersistenceError))
					const page = yield* paginateArray(response.targets.map(toV2ScrapeTarget), query)
					return { object: "list" as const, ...page }
				}),
			)
			.handle("retrieve", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const target = yield* service
						.get(tenant.orgId, params.id)
						.pipe(mapMutationError("retrieve"))
					return toV2ScrapeTarget(target)
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const created = yield* service
						.create(
							tenant.orgId,
							new CreateScrapeTargetRequest({
								name: payload.name,
								...(payload.url !== undefined ? { url: payload.url } : {}),
								...(payload.target_type !== undefined
									? { targetType: payload.target_type }
									: {}),
								...(payload.organization !== undefined
									? { organization: payload.organization }
									: {}),
								...(payload.include_branches !== undefined
									? { includeBranches: payload.include_branches }
									: {}),
								...(payload.exclude_branches !== undefined
									? { excludeBranches: payload.exclude_branches }
									: {}),
								...(payload.scrape_interval_seconds !== undefined
									? { scrapeIntervalSeconds: payload.scrape_interval_seconds }
									: {}),
								...(payload.labels_json !== undefined
									? { labelsJson: payload.labels_json }
									: {}),
								...(payload.auth_type !== undefined ? { authType: payload.auth_type } : {}),
								...(payload.service_name !== undefined
									? { serviceName: payload.service_name }
									: {}),
								...(payload.auth_credentials !== undefined
									? { authCredentials: payload.auth_credentials }
									: {}),
								...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
							}),
						)
						.pipe(mapCommonError("create"))
					return toV2ScrapeTarget(created)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const updated = yield* service
						.update(
							tenant.orgId,
							params.id,
							new UpdateScrapeTargetRequest({
								...(payload.name !== undefined ? { name: payload.name } : {}),
								...(payload.url !== undefined ? { url: payload.url } : {}),
								...(payload.organization !== undefined
									? { organization: payload.organization }
									: {}),
								...(payload.include_branches !== undefined
									? { includeBranches: payload.include_branches }
									: {}),
								...(payload.exclude_branches !== undefined
									? { excludeBranches: payload.exclude_branches }
									: {}),
								...(payload.scrape_interval_seconds !== undefined
									? { scrapeIntervalSeconds: payload.scrape_interval_seconds }
									: {}),
								...(payload.labels_json !== undefined
									? { labelsJson: payload.labels_json }
									: {}),
								...(payload.auth_type !== undefined ? { authType: payload.auth_type } : {}),
								...(payload.service_name !== undefined
									? { serviceName: payload.service_name }
									: {}),
								...(payload.auth_credentials !== undefined
									? { authCredentials: payload.auth_credentials }
									: {}),
								...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
							}),
						)
						.pipe(mapMutationError("update"))
					return toV2ScrapeTarget(updated)
				}),
			)
			.handle("delete", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const deleted = yield* service
						.delete(tenant.orgId, params.id)
						.pipe(mapMutationError("delete"))
					return { id: deleted.id, object: "scrape_target" as const, deleted: true as const }
				}),
			)
			.handle("probe", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const result = yield* service.probe(tenant.orgId, params.id).pipe(mapProbeError)
					return {
						object: "scrape_target.probe_result" as const,
						success: result.success,
						last_scrape_at: result.lastScrapeAt,
						last_scrape_error: result.lastScrapeError,
					}
				}),
			)
			.handle("listChecks", ({ params, query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
						service
							.listChecks(tenant.orgId, params.id, {
								...(query.since !== undefined ? { startTime: Date.parse(query.since) } : {}),
								...(query.until !== undefined ? { endTime: Date.parse(query.until) } : {}),
								limit,
								offset,
							})
							.pipe(
								mapMutationError("list_checks"),
								Effect.map(
									(rows): ReadonlyArray<V2ScrapeTargetCheck> =>
										rows.map((row) => ({
											object: "scrape_target.check" as const,
											timestamp: timestamp(new Date(row.checkedAt).toISOString()),
											success: row.error === null,
											sub_target_key: row.subTargetKey === "" ? null : row.subTargetKey,
											duration_seconds:
												row.durationMs === null ? null : row.durationMs / 1000,
											samples_scraped: row.samplesScraped,
											samples_post_metric_relabeling: row.samplesPostRelabel,
											message: row.error,
										})),
								),
							),
					)
					return { object: "list" as const, ...page }
				}),
			)
	}),
)
