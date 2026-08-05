import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { UserId } from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { Timestamp } from "./envelopes"
import {
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "./errors"
import { ScrapeTargetPublicId } from "./scrape-targets"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

// ---------------------------------------------------------------------------
// PlanetScale integration. An org connects PlanetScale over OAuth, binds the
// grant to one PlanetScale organization, and Maple provisions a managed scrape
// target that pulls branch metrics. Inventory (databases/branches), query
// insights, and the lifecycle event timeline ride the same connection.
//
// Promoted from the v1 `integrations` group per the rule in docs/api-v2.md:
// a provider moves to `/v2/integrations/<provider>` once something outside the
// dashboard depends on it. Infrastructure-as-code setups drive
// `POST /v2/integrations/planetscale/metrics_token` — the one step the OAuth
// flow cannot cover, because PlanetScale's metrics endpoints authenticate with
// service tokens rather than OAuth bearers — and a scripted caller needs a
// scoped API key, which only v2 has.
//
// The v1 endpoints (`/api/integrations/planetscale/*`) are still mounted and
// marked deprecated: the dashboard is off them, but customers may not be, and
// nothing in this repo would notice if they broke. This group is the surface new
// work targets; v1 gets deleted once its access logs go quiet.
//
// What did NOT move, deliberately: the OAuth *callback* and the webhook
// *receiver*. Both are browser/provider-facing raw `HttpRouter` routes under
// `/api/...` (see apps/api/src/routes/v1/integrations.http.ts and
// planetscale-webhook.http.ts). docs/api-v2.md is explicit that a handshake is
// never an API group in either tier, and the webhook URL is already registered
// in customers' PlanetScale settings — moving it would break live deliveries.
// So `connect` still mints a `/api/...` callback URL and `webhook_config` still
// reports a `/api/...` receiver URL. That is the intended end state, not debt.
//
// Scope family is `integrations`, shared with Slack: families are derived from
// the first path segment under `/v2`, so the split across two contract files is
// purely about file size.
// ---------------------------------------------------------------------------

export const V2PlanetScaleMetricsAuth = Schema.Literals(["oauth", "service_token", "missing"]).annotate({
	identifier: "PlanetScaleMetricsAuth",
	title: "PlanetScale metrics auth",
	description:
		"How branch-metrics scraping authenticates. `service_token` is the normal state: PlanetScale's metrics endpoints only document service-token auth. `oauth` applies only where the OAuth bearer probe succeeded. `missing` means scraping is paused until a service token with the `read_metrics_endpoints` permission is attached via `POST /v2/integrations/planetscale/metrics_token` — inventory, query insights, and webhooks keep working on the OAuth grant regardless.",
	examples: ["service_token"],
})
export type V2PlanetScaleMetricsAuth = Schema.Schema.Type<typeof V2PlanetScaleMetricsAuth>

export const V2PlanetScaleScrapeTarget = Schema.Struct({
	id: ScrapeTargetPublicId.annotate({
		description: "The managed scrape target's ID (`scrp_…`), as returned by `/v2/scrape_targets`.",
	}),
	object: Schema.Literal("planetscale_integration.scrape_target").annotate({
		description: 'The object type — always `"planetscale_integration.scrape_target"`.',
		examples: ["planetscale_integration.scrape_target"],
	}),
	enabled: Schema.Boolean.annotate({
		description: "Whether the target is currently being scraped.",
		examples: [true],
	}),
	scrape_interval_seconds: Schema.Number.annotate({
		description: "How often the target is scraped, in seconds.",
		examples: [60],
	}),
	include_branches: Schema.Array(Schema.String).annotate({
		description: "Branch glob allowlist. Empty means every branch.",
		examples: [["main"]],
	}),
	exclude_branches: Schema.Array(Schema.String).annotate({
		description: "Branch glob denylist, applied after `include_branches`.",
		examples: [["pr-*"]],
	}),
	last_scrape_at: Schema.NullOr(Timestamp).annotate({
		description: "When the last successful scrape completed, or `null` before the first one.",
	}),
	last_scrape_error: Schema.NullOr(Schema.String).annotate({
		description: "The error from the most recent failed scrape, or `null`.",
		examples: [null],
	}),
}).annotate({
	identifier: "PlanetScaleScrapeTarget",
	title: "PlanetScale scrape target",
	description:
		"The scrape target Maple provisioned for this connection. It is managed — it is hidden from the generic `/v2/scrape_targets` list and its branch filters are edited through `select_organization`.",
	examples: [
		wireExample({
			id: "scrp_4CzLmR",
			object: "planetscale_integration.scrape_target",
			enabled: true,
			scrape_interval_seconds: 60,
			include_branches: ["main"],
			exclude_branches: ["pr-*"],
			last_scrape_at: "2026-08-05T12:00:00.000Z",
			last_scrape_error: null,
		}),
	],
})
export type V2PlanetScaleScrapeTarget = Schema.Schema.Type<typeof V2PlanetScaleScrapeTarget>

export const V2PlanetScaleIntegration = Schema.Struct({
	object: Schema.Literal("planetscale_integration").annotate({
		description: 'The object type — always `"planetscale_integration"`.',
		examples: ["planetscale_integration"],
	}),
	connected: Schema.Boolean.annotate({
		description: "Whether a PlanetScale organization is bound and the integration is live.",
		examples: [true],
	}),
	pending_org_selection: Schema.Boolean.annotate({
		description:
			"An OAuth grant is stored but no PlanetScale organization is bound yet — call `POST /v2/integrations/planetscale/select_organization`. Mutually exclusive with `connected`.",
		examples: [false],
	}),
	organization: Schema.NullOr(Schema.String).annotate({
		description: "The PlanetScale organization slug the connection is bound to, or `null`.",
		examples: ["acme"],
	}),
	connected_by_user_id: Schema.NullOr(UserId).annotate({
		// No `examples` here: UserId is branded, so a bare string literal does not
		// typecheck as one. The struct-level example carries the shape.
		description: "The Maple user who authorized the connection (a Clerk `user_…` ID), or `null`.",
	}),
	detected_permissions: Schema.NullOr(Schema.Record(Schema.String, Schema.Boolean)).annotate({
		description:
			"The PlanetScale API permissions probed when the organization was bound, keyed by permission name (e.g. `readMetricsEndpoints`). `null` before the first probe.",
		examples: [{ readMetricsEndpoints: true }],
	}),
	metrics_auth: V2PlanetScaleMetricsAuth,
	scrape_target: Schema.NullOr(V2PlanetScaleScrapeTarget).annotate({
		description: "The managed scrape target, or `null` before one is provisioned.",
	}),
	last_inventory_at: Schema.NullOr(Timestamp).annotate({
		description: "When the database/branch inventory last refreshed, or `null` before the first refresh.",
	}),
	last_inventory_error: Schema.NullOr(Schema.String).annotate({
		description: "The error from the most recent failed inventory refresh, or `null`.",
		examples: [null],
	}),
	revoked_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the OAuth grant was revoked on PlanetScale's side, or `null` while it is live. A non-null value means every OAuth-backed call will fail until the integration is reconnected.",
	}),
	expires_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the current access token expires, or `null`. Maple refreshes well before this; it is informational.",
	}),
}).annotate({
	identifier: "PlanetScaleIntegration",
	title: "PlanetScale integration status",
	description: "The PlanetScale connection state for the authenticated organization.",
	examples: [
		wireExample({
			object: "planetscale_integration",
			connected: true,
			pending_org_selection: false,
			organization: "acme",
			connected_by_user_id: "user_2abcDEF",
			detected_permissions: { readMetricsEndpoints: true },
			metrics_auth: "service_token",
			scrape_target: {
				id: "scrp_4CzLmR",
				object: "planetscale_integration.scrape_target",
				enabled: true,
				scrape_interval_seconds: 60,
				include_branches: ["main"],
				exclude_branches: ["pr-*"],
				last_scrape_at: "2026-08-05T12:00:00.000Z",
				last_scrape_error: null,
			},
			last_inventory_at: "2026-08-05T12:00:00.000Z",
			last_inventory_error: null,
			revoked_at: null,
			expires_at: "2026-08-05T14:00:00.000Z",
		}),
	],
})
export type V2PlanetScaleIntegration = Schema.Schema.Type<typeof V2PlanetScaleIntegration>

export const V2PlanetScaleConnectRequest = Schema.Struct({
	return_to: Schema.optionalKey(Schema.String).annotate({
		description:
			"Path in the Maple dashboard to send the user back to after the callback completes. Ignored for headless callers.",
		examples: ["/integrations"],
	}),
}).annotate({
	identifier: "PlanetScaleConnectRequest",
	title: "PlanetScale connect request",
	description: "Options for beginning a PlanetScale OAuth authorization.",
	examples: [wireExample({ return_to: "/integrations" })],
})
export type V2PlanetScaleConnectRequest = Schema.Schema.Type<typeof V2PlanetScaleConnectRequest>

export const V2PlanetScaleConnectResponse = Schema.Struct({
	object: Schema.Literal("planetscale_integration.connect").annotate({
		description: 'The object type — always `"planetscale_integration.connect"`.',
		examples: ["planetscale_integration.connect"],
	}),
	redirect_url: Schema.String.annotate({
		description:
			"The PlanetScale authorize URL to send the user to. Opens PlanetScale's consent screen; on approval PlanetScale redirects back to Maple's callback.",
		examples: ["https://app.planetscale.com/oauth/authorize?client_id=..."],
	}),
	state: Schema.String.annotate({
		description: "The opaque OAuth state parameter embedded in `redirect_url`.",
		examples: ["b4f1c0e2"],
	}),
}).annotate({
	identifier: "PlanetScaleConnect",
	title: "PlanetScale connect response",
	description: "The PlanetScale OAuth authorize URL to begin a connection.",
	examples: [
		wireExample({
			object: "planetscale_integration.connect",
			redirect_url: "https://app.planetscale.com/oauth/authorize?client_id=123&state=b4f1c0e2",
			state: "b4f1c0e2",
		}),
	],
})
export type V2PlanetScaleConnectResponse = Schema.Schema.Type<typeof V2PlanetScaleConnectResponse>

export const V2PlanetScaleOrganization = Schema.Struct({
	id: Schema.String.annotate({
		description: "PlanetScale's organization ID.",
		examples: ["organization/abc123"],
	}),
	name: Schema.String.annotate({
		description: "The organization slug, as used everywhere else in this API.",
		examples: ["acme"],
	}),
}).annotate({
	identifier: "PlanetScaleOrganization",
	title: "PlanetScale organization",
	description: "One PlanetScale organization the stored OAuth grant can reach.",
	examples: [wireExample({ id: "organization/abc123", name: "acme" })],
})
export type V2PlanetScaleOrganization = Schema.Schema.Type<typeof V2PlanetScaleOrganization>

export const V2PlanetScaleOrganizationList = Schema.Struct({
	object: Schema.Literal("planetscale_integration.organization_list").annotate({
		description: 'The object type — always `"planetscale_integration.organization_list"`.',
		examples: ["planetscale_integration.organization_list"],
	}),
	organizations: Schema.Array(V2PlanetScaleOrganization).annotate({
		description: "Every organization the grant can reach.",
	}),
}).annotate({
	identifier: "PlanetScaleOrganizationList",
	title: "PlanetScale organization list",
	description:
		'Organizations the OAuth grant can access. Note: unlike most v2 collections this is **not** the standard `{ object: "list", data, has_more, next_cursor }` envelope — a grant reaches a handful of organizations and PlanetScale returns them in one unpaginated response, so there is no cursor for a client to follow.',
	examples: [
		wireExample({
			object: "planetscale_integration.organization_list",
			organizations: [{ id: "organization/abc123", name: "acme" }],
		}),
	],
})
export type V2PlanetScaleOrganizationList = Schema.Schema.Type<typeof V2PlanetScaleOrganizationList>

export const V2PlanetScaleSelectOrganizationRequest = Schema.Struct({
	organization: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()).annotate({
		description: "The PlanetScale organization slug to bind the grant to.",
		examples: ["acme"],
	}),
	include_branches: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
		description:
			"Branch glob allowlist for the managed scrape target. Omit or pass an empty array to scrape every branch.",
		examples: [["main"]],
	}),
	exclude_branches: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
		description: "Branch glob denylist for the managed scrape target, applied after the allowlist.",
		examples: [["pr-*"]],
	}),
}).annotate({
	identifier: "PlanetScaleSelectOrganizationRequest",
	title: "PlanetScale organization selection",
	description:
		"Binds the stored OAuth grant to one PlanetScale organization and provisions the managed scrape target. Re-submitting is an upsert — it is how you change organization or edit the branch filters.",
	examples: [wireExample({ organization: "acme", include_branches: ["main"], exclude_branches: ["pr-*"] })],
})
export type V2PlanetScaleSelectOrganizationRequest = Schema.Schema.Type<
	typeof V2PlanetScaleSelectOrganizationRequest
>

export const V2PlanetScaleMetricsTokenRequest = Schema.Struct({
	token_id: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()).annotate({
		description: "The PlanetScale service token ID.",
		examples: ["abcdef123456"],
	}),
	token_secret: Schema.String.check(Schema.isMinLength(1)).annotate({
		description: "The service token secret. PlanetScale prints it once, prefixed `pscale_tkn_`.",
		examples: ["pscale_tkn_example"],
	}),
}).annotate({
	identifier: "PlanetScaleMetricsTokenRequest",
	title: "PlanetScale metrics token",
	description:
		"A PlanetScale service token carrying the single `read_metrics_endpoints` permission. Maple validates it against PlanetScale's metrics discovery endpoint before storing it, and uses it for nothing else.",
	examples: [wireExample({ token_id: "abcdef123456", token_secret: "pscale_tkn_example" })],
})
export type V2PlanetScaleMetricsTokenRequest = Schema.Schema.Type<typeof V2PlanetScaleMetricsTokenRequest>

export const V2PlanetScaleDisconnectResponse = Schema.Struct({
	object: Schema.Literal("planetscale_integration").annotate({
		description: 'The object type — always `"planetscale_integration"`.',
		examples: ["planetscale_integration"],
	}),
	connected: Schema.Literal(false).annotate({
		description: "Always `false` — the integration is no longer connected.",
	}),
}).annotate({
	identifier: "PlanetScaleDisconnect",
	title: "PlanetScale disconnect response",
	description: "Confirmation that the PlanetScale connection was removed.",
	examples: [wireExample({ object: "planetscale_integration", connected: false })],
})
export type V2PlanetScaleDisconnectResponse = Schema.Schema.Type<typeof V2PlanetScaleDisconnectResponse>

export const V2PlanetScaleBranch = Schema.Struct({
	id: Schema.String.annotate({ description: "PlanetScale's branch ID.", examples: ["branch/xyz789"] }),
	name: Schema.String.annotate({ description: "The branch name.", examples: ["main"] }),
	production: Schema.Boolean.annotate({
		description: "Whether this is a production branch.",
		examples: [true],
	}),
	ready: Schema.Boolean.annotate({
		description: "Whether the branch has finished provisioning and can serve traffic.",
		examples: [true],
	}),
}).annotate({
	identifier: "PlanetScaleBranch",
	title: "PlanetScale branch",
	description: "One branch of a PlanetScale database.",
	examples: [wireExample({ id: "branch/xyz789", name: "main", production: true, ready: true })],
})
export type V2PlanetScaleBranch = Schema.Schema.Type<typeof V2PlanetScaleBranch>

export const V2PlanetScaleDatabase = Schema.Struct({
	id: Schema.String.annotate({
		description: "PlanetScale's database ID.",
		examples: ["database/def456"],
	}),
	object: Schema.Literal("planetscale_integration.database").annotate({
		description: 'The object type — always `"planetscale_integration.database"`.',
		examples: ["planetscale_integration.database"],
	}),
	name: Schema.String.annotate({ description: "The database name.", examples: ["acme-prod"] }),
	kind: Schema.String.annotate({
		description: "The product kind — `mysql` (Vitess) or `postgresql`.",
		examples: ["postgresql"],
	}),
	state: Schema.NullOr(Schema.String).annotate({
		description: "PlanetScale's lifecycle state for the database, or `null`.",
		examples: ["ready"],
	}),
	region: Schema.NullOr(Schema.String).annotate({
		description: "The region slug, or `null`.",
		examples: ["us-east"],
	}),
	plan: Schema.NullOr(Schema.String).annotate({
		description: "The billing plan, or `null`.",
		examples: ["scaler_pro"],
	}),
	branches: Schema.Array(V2PlanetScaleBranch).annotate({
		description: "The database's branches, as of the last inventory refresh.",
	}),
}).annotate({
	identifier: "PlanetScaleDatabase",
	title: "PlanetScale database",
	description: "One database from the organization's polled PlanetScale inventory.",
	examples: [
		wireExample({
			id: "database/def456",
			object: "planetscale_integration.database",
			name: "acme-prod",
			kind: "postgresql",
			state: "ready",
			region: "us-east",
			plan: "scaler_pro",
			branches: [{ id: "branch/xyz789", name: "main", production: true, ready: true }],
		}),
	],
})
export type V2PlanetScaleDatabase = Schema.Schema.Type<typeof V2PlanetScaleDatabase>

export const V2PlanetScaleDatabaseList = Schema.Struct({
	object: Schema.Literal("planetscale_integration.database_list").annotate({
		description: 'The object type — always `"planetscale_integration.database_list"`.',
		examples: ["planetscale_integration.database_list"],
	}),
	databases: Schema.Array(V2PlanetScaleDatabase).annotate({
		description: "Every database in the bound organization, as of the last inventory refresh.",
	}),
	last_inventory_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the inventory last refreshed, or `null` before the first refresh. This response is served from Maple's polled copy, not live from PlanetScale, so this is how stale it may be.",
	}),
}).annotate({
	identifier: "PlanetScaleDatabaseList",
	title: "PlanetScale database list",
	description:
		'The polled database inventory. Note: unlike most v2 collections this is **not** the standard `{ object: "list", data, has_more, next_cursor }` envelope — the inventory is a bounded snapshot returned whole, and the envelope has no place for `last_inventory_at`, which callers need to judge staleness.',
	examples: [
		wireExample({
			object: "planetscale_integration.database_list",
			databases: [
				{
					id: "database/def456",
					object: "planetscale_integration.database",
					name: "acme-prod",
					kind: "postgresql",
					state: "ready",
					region: "us-east",
					plan: "scaler_pro",
					branches: [{ id: "branch/xyz789", name: "main", production: true, ready: true }],
				},
			],
			last_inventory_at: "2026-08-05T12:00:00.000Z",
		}),
	],
})
export type V2PlanetScaleDatabaseList = Schema.Schema.Type<typeof V2PlanetScaleDatabaseList>

export const V2PlanetScaleWebhookConfig = Schema.Struct({
	object: Schema.Literal("planetscale_integration.webhook_config").annotate({
		description: 'The object type — always `"planetscale_integration.webhook_config"`.',
		examples: ["planetscale_integration.webhook_config"],
	}),
	configured: Schema.Boolean.annotate({
		description: "Whether Maple has received at least one verified delivery on this endpoint.",
		examples: [true],
	}),
	url: Schema.NullOr(Schema.String).annotate({
		description:
			"The absolute webhook URL to register in PlanetScale's per-database webhook settings, or `null` when the integration is not connected. This is a provider-facing receiver, so it lives under `/api/…` rather than `/v2/…` — the path is stable and must be registered verbatim.",
		examples: ["https://api.maple.dev/api/integrations/planetscale/webhook/abc123"],
	}),
	secret: Schema.NullOr(Schema.String).annotate({
		description:
			"The HMAC secret Maple verifies deliveries with — paste it into PlanetScale alongside the URL. `null` when not connected.",
		examples: ["whsec_example"],
	}),
}).annotate({
	identifier: "PlanetScaleWebhookConfig",
	title: "PlanetScale webhook configuration",
	description:
		"The material needed to register Maple as a webhook receiver in PlanetScale. Admin-only: the response carries the signing secret.",
	examples: [
		wireExample({
			object: "planetscale_integration.webhook_config",
			configured: true,
			url: "https://api.maple.dev/api/integrations/planetscale/webhook/abc123",
			secret: "whsec_example",
		}),
	],
})
export type V2PlanetScaleWebhookConfig = Schema.Schema.Type<typeof V2PlanetScaleWebhookConfig>

export const V2PlanetScaleQueryInsightsRequest = Schema.Struct({
	database: Schema.String.check(Schema.isMinLength(1)).annotate({
		description: "The database to inspect.",
		examples: ["acme-prod"],
	}),
	branch: Schema.optionalKey(Schema.String).annotate({
		description: "The branch to inspect. Defaults to the database's production branch.",
		examples: ["main"],
	}),
	start_time: Timestamp.annotate({ description: "Start of the window (inclusive), ISO-8601 UTC." }),
	end_time: Timestamp.annotate({
		description: "End of the window (exclusive), ISO-8601 UTC. Must be after `start_time`.",
	}),
	limit: Schema.optionalKey(Schema.Number).annotate({
		description: "Top-N queries by total time. Defaults to 10, capped at 25.",
		examples: [10],
	}),
}).annotate({
	identifier: "PlanetScaleQueryInsightsRequest",
	title: "PlanetScale query insights request",
	description:
		"A top-queries lookup for one database branch. The window is aligned to the minute server-side so repeated panel refreshes share a cache entry.",
	examples: [
		wireExample({
			database: "acme-prod",
			branch: "main",
			start_time: "2026-08-05T11:00:00.000Z",
			end_time: "2026-08-05T12:00:00.000Z",
			limit: 10,
		}),
	],
})
export type V2PlanetScaleQueryInsightsRequest = Schema.Schema.Type<typeof V2PlanetScaleQueryInsightsRequest>

export const V2PlanetScaleQueryInsight = Schema.Struct({
	object: Schema.Literal("planetscale_integration.query_insight").annotate({
		description: 'The object type — always `"planetscale_integration.query_insight"`.',
		examples: ["planetscale_integration.query_insight"],
	}),
	fingerprint: Schema.String.annotate({
		description: "PlanetScale's stable identity for the normalized query.",
		examples: ["a1b2c3d4"],
	}),
	normalized_sql: Schema.String.annotate({
		description: "The query with literals replaced by placeholders.",
		examples: ["SELECT * FROM users WHERE id = ?"],
	}),
	statement_type: Schema.NullOr(Schema.String).annotate({
		description: "`SELECT`, `INSERT`, … or `null` when PlanetScale did not classify it.",
		examples: ["SELECT"],
	}),
	query_count: Schema.Number.annotate({
		description: "Executions in the window.",
		examples: [12045],
	}),
	error_count: Schema.Number.annotate({
		description: "Executions in the window that errored.",
		examples: [3],
	}),
	total_duration_millis: Schema.Number.annotate({
		description: "Total time spent across every execution, in milliseconds.",
		examples: [48120.5],
	}),
	time_per_query_millis: Schema.Number.annotate({
		description: "Mean time per execution, in milliseconds.",
		examples: [4],
	}),
	p50_latency_millis: Schema.Number.annotate({
		description: "Median execution time, in milliseconds.",
		examples: [2.1],
	}),
	p99_latency_millis: Schema.Number.annotate({
		description: "99th-percentile execution time, in milliseconds.",
		examples: [18.4],
	}),
	rows_read_per_query: Schema.Number.annotate({
		description: "Mean rows read per execution.",
		examples: [120],
	}),
	rows_returned_per_query: Schema.Number.annotate({
		description: "Mean rows returned per execution.",
		examples: [1],
	}),
	last_run_at: Schema.NullOr(Timestamp).annotate({
		description: "When the query last ran, or `null` when PlanetScale reported none.",
	}),
}).annotate({
	identifier: "PlanetScaleQueryInsight",
	title: "PlanetScale query insight",
	description: "Aggregate statistics for one normalized query over the requested window.",
	examples: [
		wireExample({
			object: "planetscale_integration.query_insight",
			fingerprint: "a1b2c3d4",
			normalized_sql: "SELECT * FROM users WHERE id = ?",
			statement_type: "SELECT",
			query_count: 12045,
			error_count: 3,
			total_duration_millis: 48120.5,
			time_per_query_millis: 4,
			p50_latency_millis: 2.1,
			p99_latency_millis: 18.4,
			rows_read_per_query: 120,
			rows_returned_per_query: 1,
			last_run_at: "2026-08-05T11:59:00.000Z",
		}),
	],
})
export type V2PlanetScaleQueryInsight = Schema.Schema.Type<typeof V2PlanetScaleQueryInsight>

export const V2PlanetScaleQueryInsightList = Schema.Struct({
	object: Schema.Literal("planetscale_integration.query_insight_list").annotate({
		description: 'The object type — always `"planetscale_integration.query_insight_list"`.',
		examples: ["planetscale_integration.query_insight_list"],
	}),
	branch: Schema.String.annotate({
		description: "The branch actually queried — resolved server-side when the request omitted it.",
		examples: ["main"],
	}),
	data: Schema.Array(V2PlanetScaleQueryInsight).annotate({
		description:
			"The top queries, ordered by total time descending. Empty when `unavailable_reason` is set.",
	}),
	unavailable_reason: Schema.NullOr(Schema.String).annotate({
		description:
			"Why PlanetScale could not serve the lookup (service token missing `read_database`, unknown branch, …), or `null` on success. Set instead of failing the request so a dashboard can render the reason inline next to an otherwise working page.",
		examples: [null],
	}),
}).annotate({
	identifier: "PlanetScaleQueryInsightList",
	title: "PlanetScale query insight list",
	description:
		"Top queries for one branch. Note: **not** the standard list envelope — the response is a fixed top-N with no cursor, and it carries `branch` and `unavailable_reason` alongside the rows.",
	examples: [
		wireExample({
			object: "planetscale_integration.query_insight_list",
			branch: "main",
			data: [],
			unavailable_reason: null,
		}),
	],
})
export type V2PlanetScaleQueryInsightList = Schema.Schema.Type<typeof V2PlanetScaleQueryInsightList>

export const V2PlanetScaleEventCategory = Schema.Literals([
	"deploy_request",
	"branch",
	"database",
	"cluster",
	"keyspace",
]).annotate({
	identifier: "PlanetScaleEventCategory",
	title: "PlanetScale event category",
	description: "The kind of PlanetScale lifecycle object an event concerns.",
	examples: ["deploy_request"],
})
export type V2PlanetScaleEventCategory = Schema.Schema.Type<typeof V2PlanetScaleEventCategory>

export const V2PlanetScaleEventsRequest = Schema.Struct({
	database: Schema.optionalKey(Schema.String).annotate({
		description: "Restrict to one database. Omit for the organization-wide feed.",
		examples: ["acme-prod"],
	}),
	branch: Schema.optionalKey(Schema.String).annotate({
		description:
			"Restrict branch-scoped rows to one branch. Deploy requests span two branches and carry no single one, so they are never filtered out by this.",
		examples: ["main"],
	}),
	start_time: Timestamp.annotate({ description: "Start of the window (inclusive), ISO-8601 UTC." }),
	end_time: Timestamp.annotate({
		description: "End of the window (exclusive), ISO-8601 UTC. Must be after `start_time`.",
	}),
	categories: Schema.optionalKey(Schema.Array(V2PlanetScaleEventCategory)).annotate({
		description: "Restrict to these categories. Omit for all of them.",
		examples: [["deploy_request"]],
	}),
	limit: Schema.optionalKey(Schema.Number).annotate({
		description: "Maximum events to return. Defaults to 100, capped at 500.",
		examples: [100],
	}),
	cursor: Schema.optionalKey(Schema.String).annotate({
		description: "A `next_cursor` from the previous page.",
	}),
}).annotate({
	identifier: "PlanetScaleEventsRequest",
	title: "PlanetScale events request",
	description:
		"A window of the PlanetScale lifecycle timeline: deploy-request transitions and branch state changes.",
	examples: [
		wireExample({
			database: "acme-prod",
			start_time: "2026-08-05T00:00:00.000Z",
			end_time: "2026-08-05T12:00:00.000Z",
			categories: ["deploy_request"],
			limit: 100,
		}),
	],
})
export type V2PlanetScaleEventsRequest = Schema.Schema.Type<typeof V2PlanetScaleEventsRequest>

export const V2PlanetScaleEvent = Schema.Struct({
	id: Schema.String.annotate({ description: "Maple's identity for the event.", examples: ["evt_ps_123"] }),
	object: Schema.Literal("planetscale_integration.event").annotate({
		description: 'The object type — always `"planetscale_integration.event"`.',
		examples: ["planetscale_integration.event"],
	}),
	database_name: Schema.String.annotate({
		description: "The database the event belongs to.",
		examples: ["acme-prod"],
	}),
	branch_name: Schema.String.annotate({
		description: 'The branch, or `""` for events that belong to no single branch (deploy requests).',
		examples: ["main"],
	}),
	category: Schema.String.annotate({
		description:
			"One of the `PlanetScaleEventCategory` values in practice, but typed as a plain string on the way out: the classifier is deliberately forward-compatible, so a category added by a newer poller renders as an unknown row rather than failing the whole response's decode.",
		examples: ["deploy_request"],
	}),
	event_type: Schema.String.annotate({
		description: "The raw PlanetScale event string.",
		examples: ["deploy_request.schema_applied"],
	}),
	state: Schema.NullOr(Schema.String).annotate({
		description: "The resulting state, or `null`.",
		examples: ["complete"],
	}),
	external_id: Schema.String.annotate({
		description: 'The deploy-request number or branch ID; `""` when the event has none.',
		examples: ["42"],
	}),
	title: Schema.String.annotate({
		description: "A human-readable summary of the event.",
		examples: ["Deploy request #42 applied"],
	}),
	source: Schema.String.annotate({
		description: "`webhook` for live deliveries, `backfill` for REST history.",
		examples: ["webhook"],
	}),
	actor_login: Schema.NullOr(Schema.String).annotate({
		description: "The PlanetScale user who triggered it, or `null`.",
		examples: ["octocat"],
	}),
	url: Schema.NullOr(Schema.String).annotate({
		description: "A deep link into PlanetScale, or `null`.",
		examples: ["https://app.planetscale.com/acme/acme-prod/deploy-requests/42"],
	}),
	occurred_at: Timestamp.annotate({ description: "When the event occurred, truncated to the second." }),
}).annotate({
	identifier: "PlanetScaleEvent",
	title: "PlanetScale event",
	description: "One entry in the PlanetScale lifecycle timeline.",
	examples: [
		wireExample({
			id: "evt_ps_123",
			object: "planetscale_integration.event",
			database_name: "acme-prod",
			branch_name: "main",
			category: "deploy_request",
			event_type: "deploy_request.schema_applied",
			state: "complete",
			external_id: "42",
			title: "Deploy request #42 applied",
			source: "webhook",
			actor_login: "octocat",
			url: "https://app.planetscale.com/acme/acme-prod/deploy-requests/42",
			occurred_at: "2026-08-05T11:30:00.000Z",
		}),
	],
})
export type V2PlanetScaleEvent = Schema.Schema.Type<typeof V2PlanetScaleEvent>

export const V2PlanetScaleEventList = Schema.Struct({
	object: Schema.Literal("planetscale_integration.event_list").annotate({
		description: 'The object type — always `"planetscale_integration.event_list"`.',
		examples: ["planetscale_integration.event_list"],
	}),
	data: Schema.Array(V2PlanetScaleEvent).annotate({ description: "The events, newest first." }),
	next_cursor: Schema.NullOr(Schema.String).annotate({
		description: "Pass as `cursor` to fetch the next page, or `null` when this is the last one.",
		examples: [null],
	}),
}).annotate({
	identifier: "PlanetScaleEventList",
	title: "PlanetScale event list",
	description:
		"A page of the PlanetScale lifecycle timeline. Keyset-paginated with `next_cursor`; it omits `has_more` (a null cursor says the same thing) and so is not the standard list envelope.",
	examples: [
		wireExample({
			object: "planetscale_integration.event_list",
			data: [],
			next_cursor: null,
		}),
	],
})
export type V2PlanetScaleEventList = Schema.Schema.Type<typeof V2PlanetScaleEventList>

// Errors are declared per endpoint rather than from a shared tuple, matching the
// Slack group: each handler maps a small, fixed set of service failures, and a
// wider list would publish responses the API can never return. 400/401/403/429/503
// come from the middleware.
export class V2PlanetScaleIntegrationsApiGroup extends HttpApiGroup.make("planetscaleIntegration")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: V2PlanetScaleIntegration,
			error: [V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getPlanetScaleIntegration",
				summary: "Retrieve PlanetScale integration status",
				description:
					"Returns the PlanetScale connection state for your organization, including which branch-metrics authentication is in effect and the managed scrape target's health. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("connect", "/connect", {
			payload: V2PlanetScaleConnectRequest,
			// No upstream error: nothing is sent to PlanetScale until the browser
			// follows the returned authorize URL.
			success: V2PlanetScaleConnectResponse,
			error: [V2PermissionError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "connectPlanetScaleIntegration",
				summary: "Begin a PlanetScale connection",
				description:
					"Returns a PlanetScale OAuth authorize URL to redirect the user to. Browser-oriented: a headless caller cannot complete the redirect, so scripted setups should connect once from the dashboard and then drive `select_organization` and `metrics_token` over the API. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("organizations", "/organizations", {
			success: V2PlanetScaleOrganizationList,
			error: [
				V2PermissionError,
				V2NotFoundError,
				V2InvalidRequestError,
				V2UpstreamError,
				V2ServiceUnavailableError,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listPlanetScaleOrganizations",
				summary: "List reachable PlanetScale organizations",
				description:
					"Lists the PlanetScale organizations the stored OAuth grant can access — the candidates for `select_organization`. Requires an org-admin role and the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("selectOrganization", "/select_organization", {
			payload: V2PlanetScaleSelectOrganizationRequest,
			success: V2PlanetScaleIntegration,
			error: [
				V2PermissionError,
				V2NotFoundError,
				V2InvalidRequestError,
				V2UpstreamError,
				V2ServiceUnavailableError,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "selectPlanetScaleOrganization",
				summary: "Bind the connection to a PlanetScale organization",
				description:
					"Binds the stored OAuth grant to one PlanetScale organization, probes API permissions, and provisions (or adopts) the managed scrape target. Re-submitting is an upsert — use it to change organization or edit the scrape target's branch filters. Returns the refreshed integration status. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("setMetricsToken", "/metrics_token", {
			payload: V2PlanetScaleMetricsTokenRequest,
			success: V2PlanetScaleIntegration,
			error: [
				V2PermissionError,
				V2NotFoundError,
				V2InvalidRequestError,
				V2UpstreamError,
				V2ServiceUnavailableError,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "setPlanetScaleMetricsToken",
				summary: "Attach a PlanetScale metrics service token",
				description:
					"Attaches a service token carrying the single `read_metrics_endpoints` permission to the managed scrape target, enabling branch-metrics scraping. Maple validates the token against PlanetScale's metrics discovery endpoint before storing it: an invalid or under-permissioned token is rejected with `invalid_request_error` and nothing is written. Re-submitting rotates the token in place. Returns the refreshed integration status, whose `metrics_auth` becomes `service_token` on success. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("disconnect", "/", {
			success: V2PlanetScaleDisconnectResponse,
			error: [V2PermissionError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "disconnectPlanetScaleIntegration",
				summary: "Disconnect PlanetScale",
				description:
					"Removes the OAuth grant, the managed scrape target, and the stored metrics token. Polled inventory and recorded events are kept. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("databases", "/databases", {
			success: V2PlanetScaleDatabaseList,
			error: [V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listPlanetScaleDatabases",
				summary: "List PlanetScale databases",
				description:
					"Returns the polled database and branch inventory for the bound organization, plus how fresh it is. Served from Maple's copy rather than live from PlanetScale. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("webhookConfig", "/webhook_config", {
			success: V2PlanetScaleWebhookConfig,
			error: [V2PermissionError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getPlanetScaleWebhookConfig",
				summary: "Retrieve the PlanetScale webhook configuration",
				description:
					"Returns the URL and HMAC signing secret to register in PlanetScale's per-database webhook settings, so deploy-request and branch events reach Maple live instead of waiting for the REST backfill. Admin-only because the response carries the secret. Requires an org-admin role and the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("queryInsights", "/query_insights", {
			payload: V2PlanetScaleQueryInsightsRequest,
			success: V2PlanetScaleQueryInsightList,
			error: [V2NotFoundError, V2InvalidRequestError, V2UpstreamError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryPlanetScaleQueryInsights",
				summary: "Query PlanetScale query insights",
				description:
					"Returns the top queries by total time for one database branch, proxied live to PlanetScale's Query Insights API and cached briefly. Per-fingerprint cardinality is far too high to store as metrics, so this is computed on demand. A read-only operation despite being a POST — the window and filters belong in a body — so the `integrations:read` scope is sufficient.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("events", "/events", {
			payload: V2PlanetScaleEventsRequest,
			success: V2PlanetScaleEventList,
			error: [V2InvalidRequestError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listPlanetScaleEvents",
				summary: "List PlanetScale lifecycle events",
				description:
					"Returns deploy-request transitions and branch state changes for a window, newest first — the timeline behind deployment markers on infrastructure charts. A read-only operation despite being a POST, so the `integrations:read` scope is sufficient.",
			}),
		),
	)
	.prefix("/v2/integrations/planetscale")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "PlanetScale Integration",
			description:
				"Connect PlanetScale to your organization and manage what Maple collects from it: connection status, organization binding, the metrics service token that enables branch-metrics scraping, the database inventory, webhook setup, query insights, and the lifecycle event timeline.",
		}),
	) {}
