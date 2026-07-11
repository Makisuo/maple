import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	IsoDateTimeString,
	ScrapeAuthType,
	ScrapeIntervalSeconds,
	ScrapeTargetId,
	ScrapeTargetType,
} from "../primitives"
import { Authorization } from "./current-tenant"

export class ScrapeTargetResponse extends Schema.Class<ScrapeTargetResponse>("ScrapeTargetResponse")({
	id: ScrapeTargetId,
	name: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	url: Schema.String,
	targetType: ScrapeTargetType,
	/** PlanetScale organization name; `null` for plain Prometheus targets. */
	organization: Schema.NullOr(Schema.String),
	/** PlanetScale only — glob patterns; only matching branches are scraped (empty = all). */
	includeBranches: Schema.Array(Schema.String),
	/** PlanetScale only — glob patterns; matching branches are skipped (e.g. `pr-*`). */
	excludeBranches: Schema.Array(Schema.String),
	scrapeIntervalSeconds: ScrapeIntervalSeconds,
	labelsJson: Schema.NullOr(Schema.String),
	authType: ScrapeAuthType,
	hasCredentials: Schema.Boolean,
	/**
	 * Integration ownership marker (e.g. `"planetscale:{connectionId}"`); null for
	 * user-created targets. Managed rows are hidden from the generic scrape-target
	 * UI and edited through the owning integration's card.
	 */
	managedBy: Schema.NullOr(Schema.String),
	enabled: Schema.Boolean,
	lastScrapeAt: Schema.NullOr(IsoDateTimeString),
	lastScrapeError: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

export class ScrapeTargetsListResponse extends Schema.Class<ScrapeTargetsListResponse>(
	"ScrapeTargetsListResponse",
)({
	targets: Schema.Array(ScrapeTargetResponse),
}) {}

export class CreateScrapeTargetRequest extends Schema.Class<CreateScrapeTargetRequest>(
	"CreateScrapeTargetRequest",
)({
	name: Schema.String,
	/** Required for `prometheus` targets; rejected for `planetscale` (derived server-side). */
	url: Schema.optionalKey(Schema.NullOr(Schema.String)),
	targetType: Schema.optionalKey(ScrapeTargetType),
	/** Required for `planetscale` targets. */
	organization: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** PlanetScale only — branch glob allowlist (omit/empty = scrape all branches). */
	includeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	/** PlanetScale only — branch glob denylist (e.g. `pr-*` to skip PR previews). */
	excludeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	scrapeIntervalSeconds: Schema.optionalKey(ScrapeIntervalSeconds),
	labelsJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
	authType: Schema.optionalKey(ScrapeAuthType),
	serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	authCredentials: Schema.optionalKey(Schema.NullOr(Schema.String)),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class UpdateScrapeTargetRequest extends Schema.Class<UpdateScrapeTargetRequest>(
	"UpdateScrapeTargetRequest",
)({
	name: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	/** PlanetScale targets only — updates the organization and re-derives the SD url. */
	organization: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** PlanetScale only — branch glob allowlist (empty array clears it; omit = unchanged). */
	includeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	/** PlanetScale only — branch glob denylist (empty array clears it; omit = unchanged). */
	excludeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	scrapeIntervalSeconds: Schema.optionalKey(ScrapeIntervalSeconds),
	labelsJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
	authType: Schema.optionalKey(ScrapeAuthType),
	serviceName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	authCredentials: Schema.optionalKey(Schema.NullOr(Schema.String)),
	enabled: Schema.optionalKey(Schema.Boolean),
}) {}

export class ScrapeTargetDeleteResponse extends Schema.Class<ScrapeTargetDeleteResponse>(
	"ScrapeTargetDeleteResponse",
)({
	id: ScrapeTargetId,
}) {}

export class ScrapeTargetProbeResponse extends Schema.Class<ScrapeTargetProbeResponse>(
	"ScrapeTargetProbeResponse",
)({
	success: Schema.Boolean,
	lastScrapeAt: Schema.NullOr(IsoDateTimeString),
	lastScrapeError: Schema.NullOr(Schema.String),
}) {}

/**
 * One persisted scheduled-scrape attempt (a `scrape_target_checks` row),
 * reported by the scraper and stored by the API.
 */
export class ScrapeTargetCheckResponse extends Schema.Class<ScrapeTargetCheckResponse>(
	"ScrapeTargetCheckResponse",
)({
	timestamp: IsoDateTimeString,
	success: Schema.Boolean,
	/** Sub-target discriminator (e.g. PlanetScale branch); null for plain targets. */
	subTargetKey: Schema.NullOr(Schema.String),
	durationSeconds: Schema.NullOr(Schema.Number),
	samplesScraped: Schema.NullOr(Schema.Number),
	samplesPostMetricRelabeling: Schema.NullOr(Schema.Number),
	/** Null on success; the scrape failure message otherwise. */
	message: Schema.NullOr(Schema.String),
}) {}

export class ScrapeTargetChecksListResponse extends Schema.Class<ScrapeTargetChecksListResponse>(
	"ScrapeTargetChecksListResponse",
)({
	checks: Schema.Array(ScrapeTargetCheckResponse),
}) {}

export const ListScrapeTargetChecksQuery = Schema.Struct({
	since: Schema.optionalKey(IsoDateTimeString),
	until: Schema.optionalKey(IsoDateTimeString),
	limit: Schema.optionalKey(
		Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
	),
})

export class ScrapeTargetPersistenceError extends Schema.TaggedErrorClass<ScrapeTargetPersistenceError>()(
	"@maple/http/errors/ScrapeTargetPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class ScrapeTargetNotFoundError extends Schema.TaggedErrorClass<ScrapeTargetNotFoundError>()(
	"@maple/http/errors/ScrapeTargetNotFoundError",
	{
		targetId: ScrapeTargetId,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class ScrapeTargetValidationError extends Schema.TaggedErrorClass<ScrapeTargetValidationError>()(
	"@maple/http/errors/ScrapeTargetValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ScrapeTargetEncryptionError extends Schema.TaggedErrorClass<ScrapeTargetEncryptionError>()(
	"@maple/http/errors/ScrapeTargetEncryptionError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

/**
 * Authenticating a scrape target against its provider failed — token
 * resolution for a managed (OAuth-backed) target, or the provider rejecting
 * the presented credentials (e.g. PlanetScale's SD endpoint answering
 * 401/403). `reason` preserves the actionable failure class:
 * `not_connected`/`revoked` need a reconnect, `upstream` is a transient
 * provider failure, `config` is a credential/OAuth-app misconfiguration
 * (bad service token, missing scope).
 */
export class ScrapeTargetAuthError extends Schema.TaggedErrorClass<ScrapeTargetAuthError>()(
	"@maple/http/errors/ScrapeTargetAuthError",
	{
		message: Schema.String,
		reason: Schema.Literals(["not_connected", "revoked", "upstream", "config"]),
	},
	{ httpApiStatus: 502 },
) {}

/**
 * The scrape target's upstream (the provider being scraped/discovered — e.g.
 * PlanetScale's http_sd endpoint) failed at the transport level, timed out,
 * answered a non-2xx that isn't an auth rejection, or returned an undecodable
 * payload. Distinct from `ScrapeTargetPersistenceError` (503, *our* database)
 * so callers, the scrape proxy, and dashboards can tell "the provider is
 * misbehaving" (502, retryable) from "our storage broke" instead of
 * regex-sniffing the HTTP status back out of a persistence message. `status`
 * carries the upstream HTTP status when the failure reached one.
 */
export class ScrapeTargetUpstreamError extends Schema.TaggedErrorClass<ScrapeTargetUpstreamError>()(
	"@maple/http/errors/ScrapeTargetUpstreamError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
	},
	{ httpApiStatus: 502 },
) {}

export class ScrapeTargetsApiGroup extends HttpApiGroup.make("scrapeTargets")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: ScrapeTargetsListResponse,
			error: ScrapeTargetPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateScrapeTargetRequest,
			success: ScrapeTargetResponse,
			error: [ScrapeTargetValidationError, ScrapeTargetPersistenceError, ScrapeTargetEncryptionError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:targetId", {
			params: {
				targetId: ScrapeTargetId,
			},
			payload: UpdateScrapeTargetRequest,
			success: ScrapeTargetResponse,
			error: [
				ScrapeTargetNotFoundError,
				ScrapeTargetValidationError,
				ScrapeTargetPersistenceError,
				ScrapeTargetEncryptionError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:targetId", {
			params: {
				targetId: ScrapeTargetId,
			},
			success: ScrapeTargetDeleteResponse,
			error: [ScrapeTargetNotFoundError, ScrapeTargetPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("probe", "/:targetId/probe", {
			params: {
				targetId: ScrapeTargetId,
			},
			success: ScrapeTargetProbeResponse,
			error: [
				ScrapeTargetNotFoundError,
				ScrapeTargetPersistenceError,
				ScrapeTargetEncryptionError,
				ScrapeTargetAuthError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("listChecks", "/:targetId/checks", {
			params: {
				targetId: ScrapeTargetId,
			},
			query: ListScrapeTargetChecksQuery,
			success: ScrapeTargetChecksListResponse,
			error: [ScrapeTargetNotFoundError, ScrapeTargetPersistenceError],
		}),
	)
	.prefix("/api/scrape-targets")
	.middleware(Authorization) {}
