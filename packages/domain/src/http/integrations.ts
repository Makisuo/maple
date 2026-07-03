import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ExternalUserId, UserId } from "../primitives"
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
	/** Warehouse ServiceName: `cloudflare/{zone}` or `cloudflare-worker/{script}`. */
	serviceName: Schema.String,
	kind: Schema.Literals(["zone", "worker"]),
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
