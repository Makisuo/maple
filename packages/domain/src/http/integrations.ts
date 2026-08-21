import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ExternalUserId, ScrapeTargetId, UserId } from "../primitives"
import { Authorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
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
export class CloudflareUsageResponse extends Schema.Class<CloudflareUsageResponse>("CloudflareUsageResponse")(
	{
		windowStart: Schema.Number,
		windowEnd: Schema.Number,
		bucketSeconds: Schema.Number,
		totalRequests: Schema.Number,
		/**
		 * Total requests in the previous window `[windowStart − 24h, windowStart)` — backs the
		 * "vs previous 24h" delta. optionalKey only for deploy-window compat; always sent.
		 */
		previousTotalRequests: Schema.optionalKey(Schema.Number),
		/** Org-wide mitigated firewall events (block/challenge) in the current window. Always sent. */
		firewallBlockedEvents: Schema.optionalKey(Schema.Number),
		services: Schema.Array(CloudflareServiceUsage),
	},
) {}

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
	/**
	 * Server-side substring match, applied by Cloudflare before ranking. This is what makes the
	 * live lookup worth having: it reaches keys the stored per-window top-N never kept.
	 */
	contains: Schema.optionalKey(Schema.String),
	hosts: Schema.optionalKey(Schema.Array(Schema.String)),
	countries: Schema.optionalKey(Schema.Array(Schema.String)),
	methods: Schema.optionalKey(Schema.Array(Schema.String)),
	cacheStatuses: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

export class CloudflareTopTrafficRow extends Schema.Class<CloudflareTopTrafficRow>("CloudflareTopTrafficRow")(
	{
		/** Hostname or path, depending on the requested dimension. */
		key: Schema.String,
		/** ABR-adjusted request estimate. */
		requests: Schema.Number,
		bytes: Schema.Number,
		errors5xx: Schema.Number,
	},
) {}

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

// These shapes now serve two callers at once, which is why they are camelCase
// with epoch-ms timestamps and the v2 file is not:
//
//   1. The deprecated v1 endpoints at the bottom of this file, which are still
//      mounted for external callers. This is their wire contract, frozen.
//   2. `PlanetScaleConnectionService` / `PlanetScaleService`, whose method
//      signatures they are — the v2 handlers map them to the snake_case/ISO
//      wire format at the boundary, the same way the Slack handlers map
//      `SlackInstallStatus`.
//
// So (1) can be deleted once no customer is calling it, and (2) will keep these
// alive afterwards as plain service types. Do not reshape them to match v2:
// that would break the v1 wire format while it still has callers.

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
	/**
	 * Epoch ms the OAuth grant was revoked, or null while it is live. Without
	 * this the UI can only infer a revoked grant from whichever downstream call
	 * happened to fail first, so the same cause surfaced as three different
	 * error strings in three unrelated places.
	 */
	revokedAt: Schema.NullOr(Schema.Number),
	/** Epoch ms the access token expires; refresh happens well before this. */
	expiresAt: Schema.NullOr(Schema.Number),
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
 * One Hyperdrive config from the org's polled Cloudflare inventory. The origin fields
 * identify what actually sits behind the service map's collapsed Hyperdrive node —
 * the web client matches `originDatabase` against the PlanetScale inventory.
 */
export class CloudflareHyperdriveConfigSummary extends Schema.Class<CloudflareHyperdriveConfigSummary>(
	"CloudflareHyperdriveConfigSummary",
)({
	/** Cloudflare's 32-hex Hyperdrive config id. */
	id: Schema.String,
	name: Schema.String,
	/** Null for the VPC-service origin variant (no public host). */
	originHost: Schema.NullOr(Schema.String),
	/** Null for the Access-client and VPC origin variants. */
	originPort: Schema.NullOr(Schema.Number),
	/** "mysql" | "postgres" | "postgresql". */
	originScheme: Schema.String,
	originDatabase: Schema.String,
	originUser: Schema.NullOr(Schema.String),
}) {}

export class CloudflareHyperdrivesResponse extends Schema.Class<CloudflareHyperdrivesResponse>(
	"CloudflareHyperdrivesResponse",
)({
	configs: Schema.Array(CloudflareHyperdriveConfigSummary),
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

/**
 * The PlanetScale lifecycle timeline for a window: deploy-request transitions
 * and branch state changes. Backs both the chart markers on the database
 * drill-in and the activity feed under them.
 */
export const PlanetScaleEventCategory = Schema.Literals([
	"deploy_request",
	"branch",
	"database",
	"cluster",
	"keyspace",
])

export class PlanetScaleEventsRequest extends Schema.Class<PlanetScaleEventsRequest>(
	"PlanetScaleEventsRequest",
)({
	/** Omit for the org-wide feed. */
	database: Schema.optionalKey(Schema.String),
	/**
	 * Narrows branch-scoped rows. Deploy requests span two branches and carry no
	 * single one, so they are never filtered out by this.
	 */
	branch: Schema.optionalKey(Schema.String),
	/** Window bounds, epoch ms. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	categories: Schema.optionalKey(Schema.Array(PlanetScaleEventCategory)),
	/** Defaults to 100, capped at 500. */
	limit: Schema.optionalKey(Schema.Number),
	/** Keyset cursor from the previous page's `nextCursor`. */
	cursor: Schema.optionalKey(Schema.String),
}) {}

export class PlanetScaleEventSummary extends Schema.Class<PlanetScaleEventSummary>("PlanetScaleEventSummary")(
	{
		id: Schema.String,
		databaseName: Schema.String,
		/** "" for events that belong to no single branch (deploy requests). */
		branchName: Schema.String,
		/**
		 * One of `PlanetScaleEventCategory` in practice, but typed as a plain string
		 * on the way out: the classifier is deliberately forward-compatible, so a
		 * category added by a newer poller must render as an unknown row in the feed
		 * rather than fail the whole response's decode.
		 */
		category: Schema.String,
		/** Raw PlanetScale event string, e.g. "deploy_request.schema_applied". */
		eventType: Schema.String,
		state: Schema.NullOr(Schema.String),
		/** Deploy-request number or branch id; "" when the event has none. */
		externalId: Schema.String,
		title: Schema.String,
		/** "webhook" (live) or "backfill" (REST history). */
		source: Schema.String,
		actorLogin: Schema.NullOr(Schema.String),
		url: Schema.NullOr(Schema.String),
		/** Epoch ms, truncated to the second. */
		occurredAt: Schema.Number,
	},
) {}

export class PlanetScaleEventsResponse extends Schema.Class<PlanetScaleEventsResponse>(
	"PlanetScaleEventsResponse",
)({
	/** Newest first. */
	events: Schema.Array(PlanetScaleEventSummary),
	/** Null when this is the last page. */
	nextCursor: Schema.NullOr(Schema.String),
}) {}

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

/**
 * Bulk sibling of VcsCommitDetailResponse, for list views that show one deploy
 * per row. Unresolvable SHAs are absent from `commits` rather than raising —
 * the caller matches by `sha` and falls back to rendering the raw reference.
 */
export class VcsCommitDetailsResponse extends Schema.Class<VcsCommitDetailsResponse>(
	"VcsCommitDetailsResponse",
)({
	commits: Schema.Array(VcsCommitDetailResponse),
}) {}

/** Upper bound on SHAs per bulk commit lookup — one page of a list view. */
export const VCS_COMMIT_DETAILS_MAX_SHAS = 50

export class IntegrationsForbiddenError extends HttpTaggedError<IntegrationsForbiddenError>()(
	"@maple/http/errors/IntegrationsForbiddenError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "integration_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class IntegrationsValidationError extends HttpTaggedError<IntegrationsValidationError>()(
	"@maple/http/errors/IntegrationsValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "integration_request_invalid",
		title: "Invalid integration request",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Maple cannot start an integration because its server-side configuration is incomplete. */
export class IntegrationsConfigurationError extends HttpTaggedError<IntegrationsConfigurationError>()(
	"@maple/http/errors/IntegrationsConfigurationError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "integration_not_configured",
		title: "Integration is not configured",
		message: "This integration is not configured in Maple. Contact support.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

export class IntegrationsNotConnectedError extends HttpTaggedError<IntegrationsNotConnectedError>()(
	"@maple/http/errors/IntegrationsNotConnectedError",
	{
		message: Schema.String,
	},
	{
		status: 409,
		code: "integration_not_connected",
		title: "Integration not connected",
		retry: "never",
		recovery: "reconnect",
		exposure: "public_message",
	},
) {}

export class IntegrationsRevokedError extends HttpTaggedError<IntegrationsRevokedError>()(
	"@maple/http/errors/IntegrationsRevokedError",
	{
		message: Schema.String,
	},
	{
		status: 401,
		code: "integration_authorization_revoked",
		title: "Integration authorization revoked",
		message: "The integration authorization was revoked. Reconnect and try again.",
		retry: "never",
		recovery: "reconnect",
		exposure: "redacted",
	},
) {}

export class IntegrationsUpstreamError extends HttpTaggedError<IntegrationsUpstreamError>()(
	"@maple/http/errors/IntegrationsUpstreamError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 502,
		code: "integration_upstream_error",
		title: "Integration provider is unavailable",
		message: "The integration provider could not complete the request.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class IntegrationsPersistenceError extends HttpTaggedError<IntegrationsPersistenceError>()(
	"@maple/http/errors/IntegrationsPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "integration_persistence_unavailable",
		title: "Integrations are temporarily unavailable",
		message: "Integrations are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export type IntegrationHttpError =
	| IntegrationsForbiddenError
	| IntegrationsConfigurationError
	| IntegrationsNotConnectedError
	| IntegrationsRevokedError
	| IntegrationsValidationError
	| IntegrationsUpstreamError
	| IntegrationsPersistenceError

/**
 * The `/api/integrations/planetscale/*` operations are gone — `/v2/integrations/
 * planetscale` (`http/v2/integrations-planetscale.ts`) is the whole surface now:
 * scoped API keys, snake_case + ISO wire format, and the documented error
 * envelope. The schemas below stay because v2 and `PlanetScaleService` use them.
 *
 * The OAuth callback and the webhook receiver are NOT part of that retirement.
 * They keep their version-neutral raw-router paths because PlanetScale stores
 * those URLs on its side — see `docs/api-v2.md`.
 */
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
		// The org's polled Hyperdrive config inventory — consumed by the service map to
		// resolve which origin database (e.g. PlanetScale) sits behind the Hyperdrive node.
		HttpApiEndpoint.get("cloudflareHyperdrives", "/cloudflare/hyperdrive", {
			success: CloudflareHyperdrivesResponse,
			error: IntegrationsPersistenceError,
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
	.add(
		// Bulk sibling of vcsCommitDetail, for list views that would otherwise
		// issue one request (and one CORS preflight) per row. `shas` is a raw
		// comma-separated string for the same reason `:sha` is raw above —
		// unguarded telemetry values must reach the handler, which drops the
		// ones it can't resolve instead of failing the whole batch.
		HttpApiEndpoint.get("vcsCommitDetails", "/vcs/commits", {
			query: Schema.Struct({
				shas: Schema.String.check(Schema.isMinLength(1)),
			}),
			success: VcsCommitDetailsResponse,
			error: [IntegrationsNotConnectedError, IntegrationsUpstreamError, IntegrationsPersistenceError],
		}),
	)
	.prefix("/api/integrations")
	.middleware(Authorization) {}
