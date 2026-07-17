import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	ScrapeAuthType,
	ScrapeIntervalSeconds,
	ScrapeTargetId,
	ScrapeTargetType,
} from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import {
	V2InvalidRequestError,
	V2NotFoundError,
	V2ServiceUnavailableError,
	V2UpstreamError,
} from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

/** `scrp_…` public ID ⇄ internal `ScrapeTargetId` (raw UUID). */
export const ScrapeTargetPublicId = PublicId(PublicIdPrefixes.scrapeTarget, ScrapeTargetId)

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())

const scrapeTargetExample = {
	id: "scrp_YofPTrK9782DWwcnXhpcCw",
	object: "scrape_target",
	name: "payments prometheus",
	service_name: "payments",
	url: "https://payments.internal:9090/metrics",
	target_type: "prometheus",
	organization: null,
	include_branches: [],
	exclude_branches: [],
	scrape_interval_seconds: 60,
	labels_json: null,
	auth_type: "none",
	has_credentials: false,
	managed_by: null,
	enabled: true,
	last_scrape_at: "2026-07-15T09:12:00.000Z",
	last_scrape_error: null,
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

const targetTypeField = ScrapeTargetType.annotate({
	description:
		"What is being scraped: `prometheus` (a metrics endpoint you host) or `planetscale` (branch metrics discovered from a PlanetScale organization).",
	examples: ["prometheus"],
})

const authTypeField = ScrapeAuthType.annotate({
	description: "How the scraper authenticates against the target endpoint.",
	examples: ["none"],
})

const scrapeIntervalField = ScrapeIntervalSeconds.annotate({
	description: "How often the target is scraped, in seconds.",
})

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2ScrapeTarget = Schema.Struct({
	id: ScrapeTargetPublicId,
	object: Schema.Literal("scrape_target").annotate({
		description: 'The object type — always `"scrape_target"`.',
		examples: ["scrape_target"],
	}),
	name: Schema.String.annotate({
		description: "Human-readable label for the target.",
		examples: ["payments prometheus"],
	}),
	service_name: Schema.NullOr(Schema.String).annotate({
		description: "Service name the scraped metrics are attributed to, or `null` to use the target name.",
		examples: ["payments"],
	}),
	url: Schema.String.annotate({
		description:
			"The endpoint being scraped. For `planetscale` targets this is derived server-side from the organization.",
		examples: ["https://payments.internal:9090/metrics"],
	}),
	target_type: targetTypeField,
	organization: Schema.NullOr(Schema.String).annotate({
		description: "PlanetScale organization name; `null` for plain Prometheus targets.",
	}),
	include_branches: Schema.Array(Schema.String).annotate({
		description:
			"PlanetScale only — branch glob allowlist; only matching branches are scraped (empty = all branches).",
	}),
	exclude_branches: Schema.Array(Schema.String).annotate({
		description: "PlanetScale only — branch glob denylist; matching branches are skipped (e.g. `pr-*`).",
	}),
	scrape_interval_seconds: scrapeIntervalField,
	labels_json: Schema.NullOr(Schema.String).annotate({
		description: "JSON object of extra labels attached to every scraped sample, or `null`.",
	}),
	auth_type: authTypeField,
	has_credentials: Schema.Boolean.annotate({
		description:
			"Whether credentials are stored for the target. Credentials are write-only — they are never returned by the API.",
		examples: [false],
	}),
	managed_by: Schema.NullOr(Schema.String).annotate({
		description:
			"Integration ownership marker (e.g. `planetscale:{connection}`) for targets managed by an integration, or `null` for user-created targets. Managed targets are edited through the owning integration.",
	}),
	enabled: Schema.Boolean.annotate({
		description: "Whether the target is scraped on its schedule. Disabled targets are skipped.",
		examples: [true],
	}),
	last_scrape_at: Schema.NullOr(Timestamp).annotate({
		description: "When the target was last scraped, or `null` if never scraped.",
	}),
	last_scrape_error: Schema.NullOr(Schema.String).annotate({
		description: "The failure message from the most recent scrape, or `null` if it succeeded.",
	}),
	created_at: Timestamp.annotate({ description: "When the target was created." }),
	updated_at: Timestamp.annotate({ description: "When the target was last updated." }),
}).annotate({
	identifier: "ScrapeTarget",
	title: "Scrape Target",
	description:
		"A metrics endpoint Maple scrapes on a schedule — a Prometheus endpoint you host, or PlanetScale branch metrics discovered from an organization. Scraped samples flow into your metrics like any other telemetry. Credentials are write-only: responses carry `has_credentials` instead.",
	examples: [wireExample(scrapeTargetExample)],
})
export type V2ScrapeTarget = Schema.Schema.Type<typeof V2ScrapeTarget>

export const V2ScrapeTargetCreateParams = Schema.Struct({
	name: NonEmptyString.annotate({
		description: "Human-readable label for the target. Required, non-empty.",
		examples: ["payments prometheus"],
	}),
	url: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description:
				"The metrics endpoint to scrape. Required for `prometheus` targets; rejected for `planetscale` (derived server-side).",
			examples: ["https://payments.internal:9090/metrics"],
		}),
	),
	target_type: Schema.optionalKey(targetTypeField),
	organization: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description: "PlanetScale organization name. Required for `planetscale` targets.",
		}),
	),
	include_branches: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description: "PlanetScale only — branch glob allowlist (omit or empty = scrape all branches).",
		}),
	),
	exclude_branches: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description: "PlanetScale only — branch glob denylist (e.g. `pr-*` to skip PR previews).",
		}),
	),
	scrape_interval_seconds: Schema.optionalKey(scrapeIntervalField),
	labels_json: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description: "JSON object of extra labels attached to every scraped sample.",
		}),
	),
	auth_type: Schema.optionalKey(authTypeField),
	service_name: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description: "Service name to attribute the scraped metrics to.",
		}),
	),
	auth_credentials: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description: "Credentials for the target endpoint, matching `auth_type`. Write-only — never returned.",
		}),
	),
	enabled: Schema.optionalKey(
		Schema.Boolean.annotate({
			description: "Whether the target starts enabled. Defaults to `true`.",
		}),
	),
}).annotate({
	identifier: "ScrapeTargetCreateParams",
	title: "Scrape target create parameters",
	description: "Request body for creating a scrape target.",
	examples: [
		wireExample({
			name: "payments prometheus",
			url: "https://payments.internal:9090/metrics",
			target_type: "prometheus",
			scrape_interval_seconds: 60,
			auth_type: "none",
		}),
	],
})
export type V2ScrapeTargetCreateParams = Schema.Schema.Type<typeof V2ScrapeTargetCreateParams>

export const V2ScrapeTargetUpdateParams = Schema.Struct({
	name: Schema.optionalKey(NonEmptyString),
	url: Schema.optionalKey(Schema.String),
	organization: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description: "PlanetScale targets only — updates the organization and re-derives the scrape URL.",
		}),
	),
	include_branches: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description: "PlanetScale only — branch glob allowlist (empty array clears it; omit = unchanged).",
		}),
	),
	exclude_branches: Schema.optionalKey(
		Schema.Array(Schema.String).annotate({
			description: "PlanetScale only — branch glob denylist (empty array clears it; omit = unchanged).",
		}),
	),
	scrape_interval_seconds: Schema.optionalKey(scrapeIntervalField),
	labels_json: Schema.optionalKey(Schema.NullOr(Schema.String)),
	auth_type: Schema.optionalKey(authTypeField),
	service_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	auth_credentials: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({
			description: "New credentials for the target endpoint. Write-only — never returned.",
		}),
	),
	enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({
	identifier: "ScrapeTargetUpdateParams",
	title: "Scrape target update parameters",
	description: "Request body for updating a scrape target. Omitted fields are left unchanged.",
	examples: [wireExample({ enabled: false })],
})
export type V2ScrapeTargetUpdateParams = Schema.Schema.Type<typeof V2ScrapeTargetUpdateParams>

export const V2ScrapeTargetDeleteResponse = Schema.Struct({
	id: ScrapeTargetPublicId,
	object: Schema.Literal("scrape_target").annotate({
		description: 'The object type — always `"scrape_target"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` — the target no longer exists.",
	}),
}).annotate({
	identifier: "ScrapeTargetDeleteResponse",
	title: "Scrape target delete response",
	description: "Confirmation that a scrape target was deleted.",
	examples: [wireExample({ id: "scrp_YofPTrK9782DWwcnXhpcCw", object: "scrape_target", deleted: true })],
})
export type V2ScrapeTargetDeleteResponse = Schema.Schema.Type<typeof V2ScrapeTargetDeleteResponse>

export const V2ScrapeTargetProbeResult = Schema.Struct({
	object: Schema.Literal("scrape_target.probe_result").annotate({
		description: 'The object type — always `"scrape_target.probe_result"`.',
	}),
	success: Schema.Boolean.annotate({
		description: "Whether the probe scrape succeeded.",
		examples: [true],
	}),
	last_scrape_at: Schema.NullOr(Timestamp).annotate({
		description: "When the probe ran, or `null` if it could not be attempted.",
	}),
	last_scrape_error: Schema.NullOr(Schema.String).annotate({
		description: "The probe failure message, or `null` on success.",
	}),
}).annotate({
	identifier: "ScrapeTargetProbeResult",
	title: "Scrape target probe result",
	description: "The outcome of an on-demand probe scrape.",
	examples: [
		wireExample({
			object: "scrape_target.probe_result",
			success: true,
			last_scrape_at: "2026-07-15T09:12:00.000Z",
			last_scrape_error: null,
		}),
	],
})
export type V2ScrapeTargetProbeResult = Schema.Schema.Type<typeof V2ScrapeTargetProbeResult>

/** One persisted scheduled-scrape attempt. */
export const V2ScrapeTargetCheck = Schema.Struct({
	object: Schema.Literal("scrape_target.check").annotate({
		description: 'The object type — always `"scrape_target.check"`.',
	}),
	timestamp: Timestamp.annotate({ description: "When the scrape ran." }),
	success: Schema.Boolean.annotate({
		description: "Whether the scrape succeeded.",
		examples: [true],
	}),
	sub_target_key: Schema.NullOr(Schema.String).annotate({
		description: "Sub-target discriminator (e.g. the PlanetScale branch); `null` for plain targets.",
	}),
	duration_seconds: Schema.NullOr(Schema.Number).annotate({
		description: "How long the scrape took, in seconds, when recorded.",
		examples: [0.42],
	}),
	samples_scraped: Schema.NullOr(Schema.Number).annotate({
		description: "Number of samples fetched from the endpoint, when recorded.",
	}),
	samples_post_metric_relabeling: Schema.NullOr(Schema.Number).annotate({
		description: "Number of samples remaining after metric relabeling, when recorded.",
	}),
	message: Schema.NullOr(Schema.String).annotate({
		description: "The scrape failure message, or `null` on success.",
	}),
}).annotate({
	identifier: "ScrapeTargetCheck",
	title: "Scrape target check",
	description: "One scheduled-scrape attempt against a target, as reported by the scraper.",
	examples: [
		wireExample({
			object: "scrape_target.check",
			timestamp: "2026-07-15T09:12:00.000Z",
			success: true,
			sub_target_key: null,
			duration_seconds: 0.42,
			samples_scraped: 1250,
			samples_post_metric_relabeling: 1250,
			message: null,
		}),
	],
})
export type V2ScrapeTargetCheck = Schema.Schema.Type<typeof V2ScrapeTargetCheck>

/** Checks query: standard pagination plus an optional time window. */
export const V2ScrapeTargetChecksQuery = Schema.Struct({
	...ListQuery.fields,
	since: Schema.optional(
		Timestamp.annotate({
			description: "Only return checks at or after this time.",
		}),
	),
	until: Schema.optional(
		Timestamp.annotate({
			description: "Only return checks at or before this time.",
		}),
	),
}).annotate({
	identifier: "ScrapeTargetChecksQuery",
	title: "Scrape target checks query",
	description: "Pagination plus optional time-window filters for the checks list.",
})
export type V2ScrapeTargetChecksQuery = Schema.Schema.Type<typeof V2ScrapeTargetChecksQuery>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const ScrapeTargetList = ListOf(V2ScrapeTarget).annotate({
	identifier: "ScrapeTargetList",
	title: "Scrape target list",
	description: "A cursor-paginated page of scrape targets.",
})

const ScrapeTargetCheckList = ListOf(V2ScrapeTargetCheck).annotate({
	identifier: "ScrapeTargetCheckList",
	title: "Scrape target check list",
	description: "A cursor-paginated page of scrape checks, newest first.",
})

export class V2ScrapeTargetsApiGroup extends HttpApiGroup.make("scrapeTargets")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: ScrapeTargetList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listScrapeTargets",
				summary: "List scrape targets",
				description:
					"Returns your organization's scrape targets, most recently created first. Cursor-paginated. Requires the `scrape_targets:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2ScrapeTargetCreateParams,
			success: V2ScrapeTarget,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createScrapeTarget",
				summary: "Create a scrape target",
				description:
					"Creates a scrape target. `prometheus` targets need a `url`; `planetscale` targets need an `organization` (the URL is derived). Requires the `scrape_targets:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: ScrapeTargetPublicId },
			success: V2ScrapeTarget,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getScrapeTarget",
				summary: "Retrieve a scrape target",
				description:
					"Returns a single scrape target by its `scrp_…` ID. Requires the `scrape_targets:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: ScrapeTargetPublicId },
			payload: V2ScrapeTargetUpdateParams,
			success: V2ScrapeTarget,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateScrapeTarget",
				summary: "Update a scrape target",
				description:
					"Updates a target's configuration; omitted fields are unchanged. Requires the `scrape_targets:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: ScrapeTargetPublicId },
			success: V2ScrapeTargetDeleteResponse,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteScrapeTarget",
				summary: "Delete a scrape target",
				description:
					"Permanently deletes a scrape target and stops scraping it. Already-ingested metrics are unaffected. Requires the `scrape_targets:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("probe", "/:id/probe", {
			params: { id: ScrapeTargetPublicId },
			success: V2ScrapeTargetProbeResult,
			error: [...commonErrors, V2NotFoundError, V2UpstreamError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "probeScrapeTarget",
				summary: "Probe a scrape target",
				description:
					"Runs an on-demand scrape against the target and reports the outcome without waiting for the schedule. Requires the `scrape_targets:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("listChecks", "/:id/checks", {
			params: { id: ScrapeTargetPublicId },
			query: V2ScrapeTargetChecksQuery,
			success: ScrapeTargetCheckList,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listScrapeTargetChecks",
				summary: "List scrape checks",
				description:
					"Returns recent scheduled-scrape attempts for the target, newest first, optionally bounded by `since`/`until`. Cursor-paginated over the most recent 200 checks. Requires the `scrape_targets:read` scope.",
			}),
		),
	)
	.prefix("/v2/scrape_targets")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Scrape Targets",
			description:
				"Metrics endpoints Maple scrapes on a schedule — self-hosted Prometheus endpoints and PlanetScale branch metrics. Manage targets, probe them on demand, and inspect recent scrape checks. Credentials are write-only.",
		}),
	) {}
