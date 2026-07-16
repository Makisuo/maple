import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ExternalUserId, ScrapeTargetId, UserId } from "../primitives"
import { Authorization } from "./current-tenant"
import {
	GitCommitSha,
	VcsAccountType,
	VcsCommitNotFoundError,
	VcsCommitShaInvalidError,
	VcsProviderId,
	VcsRepoSelection,
	VcsRepoStatus,
	VcsRepoSyncStatus,
	VcsRepositoryId,
} from "./vcs"

export class HazelIntegrationStatus extends Schema.Class<HazelIntegrationStatus>("HazelIntegrationStatus")({
	connected: Schema.Boolean,
	externalUserId: Schema.NullOr(ExternalUserId),
	externalUserEmail: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(UserId),
	scope: Schema.NullOr(Schema.String),
}) {}

export class HazelOrganizationSummary extends Schema.Class<HazelOrganizationSummary>(
	"HazelOrganizationSummary",
)({
	id: Schema.String,
	name: Schema.String,
	slug: Schema.NullOr(Schema.String),
	logoUrl: Schema.NullOr(Schema.String),
}) {}

export class HazelOrganizationsListResponse extends Schema.Class<HazelOrganizationsListResponse>(
	"HazelOrganizationsListResponse",
)({
	organizations: Schema.Array(HazelOrganizationSummary),
}) {}

export const HazelChannelType = Schema.Literals(["public", "private"]).annotate({
	identifier: "@maple/HazelChannelType",
	title: "Hazel Channel Type",
})
export type HazelChannelType = Schema.Schema.Type<typeof HazelChannelType>

export class HazelChannelSummary extends Schema.Class<HazelChannelSummary>("HazelChannelSummary")({
	id: Schema.String,
	name: Schema.String,
	type: HazelChannelType,
	organizationId: Schema.String,
}) {}

export class HazelChannelsListResponse extends Schema.Class<HazelChannelsListResponse>(
	"HazelChannelsListResponse",
)({
	channels: Schema.Array(HazelChannelSummary),
}) {}

export class HazelStartConnectRequest extends Schema.Class<HazelStartConnectRequest>(
	"HazelStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class HazelStartConnectResponse extends Schema.Class<HazelStartConnectResponse>(
	"HazelStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class HazelDisconnectResponse extends Schema.Class<HazelDisconnectResponse>("HazelDisconnectResponse")(
	{
		disconnected: Schema.Boolean,
	},
) {}

// ---- Cloudflare (account OAuth + telemetry auto-provisioning) --------------

/** Per-zone edge-analytics collection state (from the GraphQL Analytics poller). */
export class CloudflareAnalyticsZoneStatus extends Schema.Class<CloudflareAnalyticsZoneStatus>(
	"CloudflareAnalyticsZoneStatus",
)({
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastError: Schema.NullOr(Schema.String),
	/** Last successfully-ingested 5-min bucket (epoch ms) — how far the poller has caught up. */
	watermarkAt: Schema.NullOr(Schema.Number),
}) {}

/** Account-level Workers invocation-metrics collection state. */
export class CloudflareAnalyticsWorkersStatus extends Schema.Class<CloudflareAnalyticsWorkersStatus>(
	"CloudflareAnalyticsWorkersStatus",
)({
	enabled: Schema.Boolean,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastError: Schema.NullOr(Schema.String),
	/** Last successfully-ingested 5-min bucket (epoch ms) — how far the poller has caught up. */
	watermarkAt: Schema.NullOr(Schema.Number),
}) {}

/**
 * Connection state of the Cloudflare integration. `accountId`/`accountName` identify the single
 * Cloudflare account the OAuth token is scoped to (Maple enforces exactly one account per org).
 * `analyticsCapable` is false when the stored grant predates the analytics scopes — the UI offers
 * an "Update permissions" reconnect; `zones`/`workers` surface the poller's per-dataset state.
 */
export class CloudflareIntegrationStatus extends Schema.Class<CloudflareIntegrationStatus>(
	"CloudflareIntegrationStatus",
)({
	connected: Schema.Boolean,
	accountId: Schema.NullOr(Schema.String),
	accountName: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(UserId),
	scope: Schema.NullOr(Schema.String),
	analyticsCapable: Schema.Boolean,
	zones: Schema.Array(CloudflareAnalyticsZoneStatus),
	workers: Schema.NullOr(CloudflareAnalyticsWorkersStatus),
}) {}

/**
 * One hourly bucket of ingested Cloudflare edge data. Buckets are sparse —
 * hours with no ingested rows are omitted; the client zero-fills the window.
 */
export class CloudflareUsageBucket extends Schema.Class<CloudflareUsageBucket>("CloudflareUsageBucket")({
	/** Start of the hour, epoch ms. */
	bucketStart: Schema.Number,
	/** Sum of the request-count metric values in the bucket. */
	requests: Schema.Number,
	/** Raw metric datapoints ingested in the bucket. */
	datapoints: Schema.Number,
}) {}

/**
 * Ingest proof for one Cloudflare-derived service (a zone or a Worker script) over the
 * usage window — computed from the warehouse, not the poller's bookkeeping, so it shows
 * the data actually queryable in dashboards.
 */
export class CloudflareServiceUsage extends Schema.Class<CloudflareServiceUsage>("CloudflareServiceUsage")({
	/** Warehouse ServiceName: `cloudflare/{zone}`, `cloudflare-worker/{script}`, `cloudflare-queue/{queue}`, …. */
	serviceName: Schema.String,
	kind: Schema.Literals(["zone", "worker", "queue"]),
	/** Zone or Worker script name with the ServiceName prefix stripped. */
	displayName: Schema.String,
	totalRequests: Schema.Number,
	totalDatapoints: Schema.Number,
	/** Most recent metric timestamp in the warehouse (epoch ms) — end-to-end delivery proof. */
	lastDataAt: Schema.NullOr(Schema.Number),
	buckets: Schema.Array(CloudflareUsageBucket),
}) {}

/** Warehouse-derived Cloudflare ingest usage for the org, fixed at the last 24h hourly. */
export class CloudflareUsageResponse extends Schema.Class<CloudflareUsageResponse>(
	"CloudflareUsageResponse",
)({
	windowStart: Schema.Number,
	windowEnd: Schema.Number,
	bucketSeconds: Schema.Number,
	totalRequests: Schema.Number,
	services: Schema.Array(CloudflareServiceUsage),
}) {}

/**
 * Live top-hosts/top-paths lookup for one zone, proxied straight to Cloudflare's GraphQL
 * Analytics API — path cardinality is far too high to store as metrics, so this is computed
 * on demand (and edge-cached briefly) instead of read from the warehouse.
 */
export class CloudflareTopTrafficRequest extends Schema.Class<CloudflareTopTrafficRequest>(
	"CloudflareTopTrafficRequest",
)({
	zoneName: Schema.String,
	dimension: Schema.Literals(["host", "path"]),
	/** Window bounds, epoch ms. Bounded server-side by the zone plan's retention. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	/** Top-N size; defaults to 15, capped at 50. */
	limit: Schema.optionalKey(Schema.Number),
}) {}

export class CloudflareTopTrafficRow extends Schema.Class<CloudflareTopTrafficRow>(
	"CloudflareTopTrafficRow",
)({
	/** Hostname or path, depending on the requested dimension. */
	key: Schema.String,
	/** ABR-adjusted request estimate. */
	requests: Schema.Number,
	bytes: Schema.Number,
	errors5xx: Schema.Number,
}) {}

export class CloudflareTopTrafficResponse extends Schema.Class<CloudflareTopTrafficResponse>(
	"CloudflareTopTrafficResponse",
)({
	rows: Schema.Array(CloudflareTopTrafficRow),
	/**
	 * Set instead of failing when Cloudflare can't serve the query for this zone/plan
	 * (authz, dataset unavailable) — the UI renders it as an inline empty-state.
	 */
	unavailableReason: Schema.NullOr(Schema.String),
}) {}

export class CloudflareStartConnectRequest extends Schema.Class<CloudflareStartConnectRequest>(
	"CloudflareStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class CloudflareStartConnectResponse extends Schema.Class<CloudflareStartConnectResponse>(
	"CloudflareStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class CloudflareDisconnectResponse extends Schema.Class<CloudflareDisconnectResponse>(
	"CloudflareDisconnectResponse",
)({
	disconnected: Schema.Boolean,
}) {}

// ---- PlanetScale (OAuth integration) ----------------------------------------

/**
 * The managed scrape target this connection auto-provisioned — surfaced on the
 * integration card so scraping health and branch filters are editable there
 * (managed rows are hidden from the generic scrape-target UI).
 */
export class PlanetScaleScrapeTargetSummary extends Schema.Class<PlanetScaleScrapeTargetSummary>(
	"PlanetScaleScrapeTargetSummary",
)({
	id: ScrapeTargetId,
	enabled: Schema.Boolean,
	scrapeIntervalSeconds: Schema.Number,
	includeBranches: Schema.Array(Schema.String),
	excludeBranches: Schema.Array(Schema.String),
	/** Epoch ms of the last successful scrape; null before the first one. */
	lastScrapeAt: Schema.NullOr(Schema.Number),
	lastScrapeError: Schema.NullOr(Schema.String),
}) {}

export class PlanetScaleIntegrationStatus extends Schema.Class<PlanetScaleIntegrationStatus>(
	"PlanetScaleIntegrationStatus",
)({
	connected: Schema.Boolean,
	/**
	 * OAuth grant stored but no organization bound yet — the UI shows the org
	 * picker. Mutually exclusive with `connected`.
	 */
	pendingOrgSelection: Schema.Boolean,
	/** PlanetScale organization slug the connection is bound to. */
	organization: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(UserId),
	/** API permissions probed at org-binding time (e.g. readMetricsEndpoints). */
	detectedPermissions: Schema.NullOr(Schema.Record(Schema.String, Schema.Boolean)),
	/**
	 * How branch-metrics scraping authenticates. PlanetScale's metrics endpoints
	 * only document service-token auth, so "oauth" applies only when the bearer
	 * probe succeeded; "missing" means scraping is paused until a service token
	 * with the read_metrics_endpoints permission is added (the one manual step —
	 * inventory, insights, and webhooks run on the OAuth grant regardless).
	 */
	metricsAuth: Schema.Literals(["oauth", "service_token", "missing"]),
	scrapeTarget: Schema.NullOr(PlanetScaleScrapeTargetSummary),
	/** Epoch ms of the last successful inventory refresh; null before the first. */
	lastInventoryAt: Schema.NullOr(Schema.Number),
	lastInventoryError: Schema.NullOr(Schema.String),
}) {}

export class PlanetScaleStartConnectRequest extends Schema.Class<PlanetScaleStartConnectRequest>(
	"PlanetScaleStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class PlanetScaleStartConnectResponse extends Schema.Class<PlanetScaleStartConnectResponse>(
	"PlanetScaleStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

/** One PlanetScale organization the OAuth grant can access — org-picker material. */
export class PlanetScaleOrganizationSummary extends Schema.Class<PlanetScaleOrganizationSummary>(
	"PlanetScaleOrganizationSummary",
)({
	id: Schema.String,
	name: Schema.String,
}) {}

export class PlanetScaleOrganizationsResponse extends Schema.Class<PlanetScaleOrganizationsResponse>(
	"PlanetScaleOrganizationsResponse",
)({
	organizations: Schema.Array(PlanetScaleOrganizationSummary),
}) {}

/**
 * Bind the stored OAuth grant to one PlanetScale organization and provision the
 * managed scrape target. Called automatically from the OAuth callback when the
 * grant reaches exactly one org, or from the org picker otherwise. Re-binding
 * (changing org / editing filters) is an upsert.
 */
export class PlanetScaleSelectOrganizationRequest extends Schema.Class<PlanetScaleSelectOrganizationRequest>(
	"PlanetScaleSelectOrganizationRequest",
)({
	/** PlanetScale organization slug. */
	organization: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
	/** Branch glob allowlist for the managed scrape target (omit/empty = all branches). */
	includeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Branch glob denylist for the managed scrape target (e.g. `pr-*`). */
	excludeBranches: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export class PlanetScaleDisconnectResponse extends Schema.Class<PlanetScaleDisconnectResponse>(
	"PlanetScaleDisconnectResponse",
)({
	disconnected: Schema.Boolean,
}) {}

/**
 * Attach a service token (permission: read_metrics_endpoints only) to the
 * managed scrape target. PlanetScale's Prometheus discovery + branch metrics
 * endpoints authenticate with service tokens, not OAuth bearers — this is the
 * one manual step the OAuth flow can't cover.
 */
export class PlanetScaleMetricsTokenRequest extends Schema.Class<PlanetScaleMetricsTokenRequest>(
	"PlanetScaleMetricsTokenRequest",
)({
	tokenId: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
	tokenSecret: Schema.String.check(Schema.isMinLength(1)),
}) {}

export class PlanetScaleBranchSummary extends Schema.Class<PlanetScaleBranchSummary>(
	"PlanetScaleBranchSummary",
)({
	id: Schema.String,
	name: Schema.String,
	production: Schema.Boolean,
	ready: Schema.Boolean,
}) {}

/** One database from the org's polled PlanetScale inventory. */
export class PlanetScaleDatabaseSummary extends Schema.Class<PlanetScaleDatabaseSummary>(
	"PlanetScaleDatabaseSummary",
)({
	/** PlanetScale's database id. */
	id: Schema.String,
	name: Schema.String,
	/** Product kind: "mysql" (Vitess) or "postgresql". */
	kind: Schema.String,
	state: Schema.NullOr(Schema.String),
	region: Schema.NullOr(Schema.String),
	plan: Schema.NullOr(Schema.String),
	branches: Schema.Array(PlanetScaleBranchSummary),
}) {}

export class PlanetScaleDatabasesResponse extends Schema.Class<PlanetScaleDatabasesResponse>(
	"PlanetScaleDatabasesResponse",
)({
	databases: Schema.Array(PlanetScaleDatabaseSummary),
	/** Epoch ms of the last successful inventory refresh; null before the first. */
	lastInventoryAt: Schema.NullOr(Schema.Number),
}) {}

/**
 * Manual webhook setup material (admin-only): the endpoint path to register in
 * PlanetScale's per-database webhook settings, and the HMAC secret Maple
 * verifies deliveries with.
 */
export class PlanetScaleWebhookConfigResponse extends Schema.Class<PlanetScaleWebhookConfigResponse>(
	"PlanetScaleWebhookConfigResponse",
)({
	configured: Schema.Boolean,
	/** Absolute webhook URL to paste into PlanetScale (built from the API origin). */
	url: Schema.NullOr(Schema.String),
	secret: Schema.NullOr(Schema.String),
}) {}

/**
 * Live top-queries lookup for one database branch, proxied to PlanetScale's
 * Query Insights API — per-fingerprint cardinality is far too high to store as
 * metrics, so this is computed on demand (and edge-cached briefly), mirroring
 * the Cloudflare top-traffic pattern.
 */
export class PlanetScaleQueryInsightsRequest extends Schema.Class<PlanetScaleQueryInsightsRequest>(
	"PlanetScaleQueryInsightsRequest",
)({
	database: Schema.String.check(Schema.isMinLength(1)),
	/** Branch to inspect; defaults to the database's production branch. */
	branch: Schema.optionalKey(Schema.String),
	/** Window bounds, epoch ms. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	/** Top-N by total time; defaults to 10, capped at 25. */
	limit: Schema.optionalKey(Schema.Number),
}) {}

export class PlanetScaleQueryInsightRow extends Schema.Class<PlanetScaleQueryInsightRow>(
	"PlanetScaleQueryInsightRow",
)({
	fingerprint: Schema.String,
	normalizedSql: Schema.String,
	statementType: Schema.NullOr(Schema.String),
	queryCount: Schema.Number,
	errorCount: Schema.Number,
	totalDurationMillis: Schema.Number,
	timePerQueryMillis: Schema.Number,
	p50LatencyMillis: Schema.Number,
	p99LatencyMillis: Schema.Number,
	rowsReadPerQuery: Schema.Number,
	rowsReturnedPerQuery: Schema.Number,
	/** Epoch ms; null when PlanetScale reported none. */
	lastRunAt: Schema.NullOr(Schema.Number),
}) {}

export class PlanetScaleQueryInsightsResponse extends Schema.Class<PlanetScaleQueryInsightsResponse>(
	"PlanetScaleQueryInsightsResponse",
)({
	/** The branch actually queried (resolved server-side when omitted). */
	branch: Schema.String,
	rows: Schema.Array(PlanetScaleQueryInsightRow),
	/**
	 * Set instead of failing when PlanetScale can't serve the lookup (token
	 * missing read_database, unknown branch) — the UI renders it inline.
	 */
	unavailableReason: Schema.NullOr(Schema.String),
}) {}

// ---- GitHub (VCS App installation) ----------------------------------------

/** One branch a repo knows about — an option in the tracked-branch picker. */
export class GithubBranchSummary extends Schema.Class<GithubBranchSummary>("GithubBranchSummary")({
	name: Schema.String,
	isDefault: Schema.Boolean,
}) {}

/** One synced repository, surfaced read-only so the dashboard can watch backfill. */
export class GithubRepoSummary extends Schema.Class<GithubRepoSummary>("GithubRepoSummary")({
	// Maple's internal repository id — the stable handle for delete-from-Maple.
	// The provider's `externalRepoId` is an internal sync detail, not surfaced here.
	id: VcsRepositoryId,
	fullName: Schema.String,
	htmlUrl: Schema.String,
	isPrivate: Schema.Boolean,
	// Access lifecycle: "active" or "removed" (provider revoked access — see VcsRepoStatus).
	status: VcsRepoStatus,
	syncStatus: VcsRepoSyncStatus,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastSyncError: Schema.NullOr(Schema.String),
	// The single branch this repo tracks (only its commits are synced). Falls back
	// to the default branch for a legacy row whose tracked branch was never set.
	trackedBranch: Schema.NullOr(Schema.String),
	// All branches the repo knows about (names only) — the picker's options.
	branches: Schema.Array(GithubBranchSummary),
}) {}

/**
 * The dashboard-facing connection state of the GitHub integration:
 * - `connected`: a live, active installation.
 * - `disconnected`: the Maple GitHub App was uninstalled (or access fully revoked)
 *   on GitHub's side. The installation row and its synced data are KEPT — never
 *   auto-deleted — so the dashboard can explain what happened and offer a reconnect.
 * - `suspended`: GitHub temporarily suspended the installation; reconnect/reactivate.
 * - `not_connected`: this org has never connected GitHub (the first-run state).
 * `connected` (boolean) stays as the `state === "connected"` shorthand the card keys on.
 */
export const GithubConnectionState = Schema.Literals([
	"connected",
	"disconnected",
	"suspended",
	"not_connected",
]).annotate({ identifier: "@maple/GithubConnectionState", title: "GitHub Connection State" })
export type GithubConnectionState = Schema.Schema.Type<typeof GithubConnectionState>

export class GithubIntegrationStatus extends Schema.Class<GithubIntegrationStatus>("GithubIntegrationStatus")(
	{
		connected: Schema.Boolean,
		// Finer-grained than `connected`: distinguishes a never-connected org from one
		// whose installation was deactivated on GitHub (so the dashboard can say why).
		state: GithubConnectionState,
		accountLogin: Schema.NullOr(Schema.String),
		accountType: Schema.NullOr(VcsAccountType),
		repositorySelection: Schema.NullOr(VcsRepoSelection),
		repositories: Schema.Array(GithubRepoSummary),
	},
) {}

export class GithubStartConnectRequest extends Schema.Class<GithubStartConnectRequest>(
	"GithubStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class GithubStartConnectResponse extends Schema.Class<GithubStartConnectResponse>(
	"GithubStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class GithubDisconnectResponse extends Schema.Class<GithubDisconnectResponse>(
	"GithubDisconnectResponse",
)({
	disconnected: Schema.Boolean,
}) {}

export class GithubDeleteRepositoryResponse extends Schema.Class<GithubDeleteRepositoryResponse>(
	"GithubDeleteRepositoryResponse",
)({
	deleted: Schema.Boolean,
}) {}

export class GithubSetTrackedBranchRequest extends Schema.Class<GithubSetTrackedBranchRequest>(
	"GithubSetTrackedBranchRequest",
)({
	// The single branch to track. Must be one the repo knows about. Changing it
	// wipes the repo's stored commits and re-backfills the new branch.
	trackedBranch: Schema.String,
}) {}

export class GithubSetTrackedBranchResponse extends Schema.Class<GithubSetTrackedBranchResponse>(
	"GithubSetTrackedBranchResponse",
)({
	trackedBranch: Schema.String,
	// True when the change enqueued a historical backfill of the new branch.
	backfillQueued: Schema.Boolean,
}) {}

// ---- Commit hover cards (vendor-agnostic) ---------------------------------

/**
 * A single resolved commit, for the dashboard's commit-SHA hover card. Provider-
 * neutral: any connected VCS provider resolves into this same shape. `resolved`
 * distinguishes a DB hit ("stored") from an on-the-fly provider fetch ("fetched")
 * — purely diagnostic.
 */
export class VcsCommitDetailResponse extends Schema.Class<VcsCommitDetailResponse>("VcsCommitDetailResponse")(
	{
		provider: VcsProviderId,
		sha: GitCommitSha,
		message: Schema.String,
		authorName: Schema.NullOr(Schema.String),
		authorEmail: Schema.NullOr(Schema.String),
		authorLogin: Schema.NullOr(Schema.String),
		authorAvatarUrl: Schema.NullOr(Schema.String),
		authoredAt: Schema.NullOr(Schema.Number),
		committedAt: Schema.Number,
		htmlUrl: Schema.String,
		repoFullName: Schema.String,
		resolved: Schema.Literals(["stored", "fetched"]),
	},
) {}

export class IntegrationsForbiddenError extends Schema.TaggedErrorClass<IntegrationsForbiddenError>()(
	"@maple/http/errors/IntegrationsForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class IntegrationsValidationError extends Schema.TaggedErrorClass<IntegrationsValidationError>()(
	"@maple/http/errors/IntegrationsValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class IntegrationsNotConnectedError extends Schema.TaggedErrorClass<IntegrationsNotConnectedError>()(
	"@maple/http/errors/IntegrationsNotConnectedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

export class IntegrationsRevokedError extends Schema.TaggedErrorClass<IntegrationsRevokedError>()(
	"@maple/http/errors/IntegrationsRevokedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

export class IntegrationsUpstreamError extends Schema.TaggedErrorClass<IntegrationsUpstreamError>()(
	"@maple/http/errors/IntegrationsUpstreamError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{ httpApiStatus: 502 },
) {}

export class IntegrationsPersistenceError extends Schema.TaggedErrorClass<IntegrationsPersistenceError>()(
	"@maple/http/errors/IntegrationsPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class IntegrationsApiGroup extends HttpApiGroup.make("integrations")
	.add(
		HttpApiEndpoint.get("hazelStatus", "/hazel/status", {
			success: HazelIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("hazelStart", "/hazel/start", {
			payload: HazelStartConnectRequest,
			success: HazelStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("hazelOrganizations", "/hazel/organizations", {
			success: HazelOrganizationsListResponse,
			error: [
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("hazelChannels", "/hazel/organizations/:organizationId/channels", {
			params: {
				organizationId: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
			},
			success: HazelChannelsListResponse,
			error: [
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("hazelDisconnect", "/hazel", {
			success: HazelDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("cloudflareStatus", "/cloudflare/status", {
			success: CloudflareIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("cloudflareUsage", "/cloudflare/usage", {
			success: CloudflareUsageResponse,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareTopTraffic", "/cloudflare/top-traffic", {
			payload: CloudflareTopTrafficRequest,
			success: CloudflareTopTrafficResponse,
			error: [
				IntegrationsNotConnectedError,
				IntegrationsValidationError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareStart", "/cloudflare/start", {
			payload: CloudflareStartConnectRequest,
			success: CloudflareStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("cloudflareDisconnect", "/cloudflare", {
			success: CloudflareDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("planetscaleStatus", "/planetscale/status", {
			success: PlanetScaleIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("planetscaleStart", "/planetscale/start", {
			payload: PlanetScaleStartConnectRequest,
			success: PlanetScaleStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		// Organizations the stored OAuth grant can access — drives the org picker
		// while the connection is pendingOrgSelection (and "change organization").
		HttpApiEndpoint.get("planetscaleOrganizations", "/planetscale/organizations", {
			success: PlanetScaleOrganizationsResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		// Binds the OAuth grant to one PlanetScale organization: probes API
		// permissions, then auto-provisions (or adopts) the managed scrape target.
		// Re-binding is an upsert.
		HttpApiEndpoint.post("planetscaleSelectOrganization", "/planetscale/select-organization", {
			payload: PlanetScaleSelectOrganizationRequest,
			success: PlanetScaleIntegrationStatus,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		// Validates the token against the metrics discovery endpoint before
		// storing it on the managed scrape target (re-submitting rotates it).
		HttpApiEndpoint.post("planetscaleSetMetricsToken", "/planetscale/metrics-token", {
			payload: PlanetScaleMetricsTokenRequest,
			success: PlanetScaleIntegrationStatus,
			error: [
				IntegrationsForbiddenError,
				IntegrationsNotConnectedError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("planetscaleDisconnect", "/planetscale", {
			success: PlanetScaleDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		// The org's polled database/branch inventory — consumed by the service map
		// (node branding + metric-overlay matching) and the infra page.
		HttpApiEndpoint.get("planetscaleDatabases", "/planetscale/databases", {
			success: PlanetScaleDatabasesResponse,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("planetscaleWebhookConfig", "/planetscale/webhook-config", {
			success: PlanetScaleWebhookConfigResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("planetscaleQueryInsights", "/planetscale/query-insights", {
			payload: PlanetScaleQueryInsightsRequest,
			success: PlanetScaleQueryInsightsResponse,
			error: [
				IntegrationsNotConnectedError,
				IntegrationsValidationError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("githubStatus", "/github/status", {
			success: GithubIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("githubStart", "/github/start", {
			payload: GithubStartConnectRequest,
			success: GithubStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDisconnect", "/github", {
			success: GithubDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDeleteRepository", "/github/repositories/:repositoryId", {
			params: {
				repositoryId: VcsRepositoryId,
			},
			success: GithubDeleteRepositoryResponse,
			// Validation: a repo can only be deleted once its provider access was
			// removed (status "removed"); deleting an active repo is rejected (400).
			error: [IntegrationsForbiddenError, IntegrationsValidationError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.put("githubSetTrackedBranch", "/github/repositories/:repositoryId/tracked-branch", {
			params: {
				repositoryId: VcsRepositoryId,
			},
			payload: GithubSetTrackedBranchRequest,
			success: GithubSetTrackedBranchResponse,
			error: [IntegrationsForbiddenError, IntegrationsValidationError, IntegrationsPersistenceError],
		}),
	)
	.add(
		// Vendor-neutral: resolves a commit by SHA across all connected providers.
		// `:sha` is a raw string (NOT `GitCommitSha`) on purpose — unguarded telemetry
		// values must reach the handler so they surface as VcsCommitShaInvalidError
		// (422) rather than a generic decode 400.
		HttpApiEndpoint.get("vcsCommitDetail", "/vcs/commits/:sha", {
			params: {
				sha: Schema.String.check(Schema.isMinLength(1)),
			},
			success: VcsCommitDetailResponse,
			error: [
				VcsCommitShaInvalidError,
				VcsCommitNotFoundError,
				IntegrationsNotConnectedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.prefix("/api/integrations")
	.middleware(Authorization) {}
