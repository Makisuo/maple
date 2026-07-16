import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AlertDestinationId, HazelChannelId, HazelOrganizationId } from "../../primitives"
import { AlertDestinationType, MAX_EMAIL_RECIPIENTS } from "../alerts"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import {
	V2ConflictError,
	V2InvalidRequestError,
	V2NotFoundError,
	V2PermissionError,
	V2ServiceUnavailableError,
} from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

/** `dest_…` public ID ⇄ internal `AlertDestinationId` (raw UUID). */
export const AlertDestinationPublicId = PublicId(PublicIdPrefixes.alertDestination, AlertDestinationId)

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed()))

const OptionalNonEmptyString = Schema.optionalKey(NonEmptyString)

/**
 * Recipients are workspace members, referenced by user id. The server resolves
 * each id to the member's email via the auth provider at save time, so API
 * consumers can never route alerts to arbitrary addresses.
 */
const MemberUserIdList = Schema.Array(NonEmptyString).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_EMAIL_RECIPIENTS),
)

const alertDestinationExample = {
	id: "dest_oybbpTBhtSFGShMjjLiCrh",
	object: "alert_destination",
	name: "On-call Slack",
	type: "slack",
	enabled: true,
	summary: "Slack webhook → #incidents",
	channel_label: "#incidents",
	member_user_ids: null,
	last_tested_at: "2026-07-15T09:12:00.000Z",
	last_test_error: null,
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

// v2 wire schemas are annotated `Schema.Struct`s (not `Schema.Class`) — see the
// note in api-keys.ts.
export const V2AlertDestination = Schema.Struct({
	id: AlertDestinationPublicId,
	object: Schema.Literal("alert_destination").annotate({
		description: 'The object type — always `"alert_destination"`.',
		examples: ["alert_destination"],
	}),
	name: Schema.String.annotate({
		description: "Human-readable label for the destination, shown in the dashboard and in rule editors.",
		examples: ["On-call Slack"],
	}),
	type: AlertDestinationType.annotate({
		description:
			"The delivery channel: `slack`, `pagerduty`, `webhook`, `hazel`, `hazel-oauth`, `discord`, or `email`. Immutable after creation.",
		examples: ["slack"],
	}),
	enabled: Schema.Boolean.annotate({
		description: "Whether the destination receives notifications. Disabled destinations are skipped at delivery time.",
		examples: [true],
	}),
	summary: Schema.String.annotate({
		description:
			"Redacted, human-readable summary of the destination's configuration. Secrets (webhook URLs, integration keys, signing secrets) are write-only — they are never returned by the API.",
		examples: ["Slack webhook → #incidents"],
	}),
	channel_label: Schema.NullOr(Schema.String).annotate({
		description: "Optional display label for the target channel (Slack destinations), or `null`.",
		examples: ["#incidents"],
	}),
	member_user_ids: Schema.NullOr(Schema.Array(Schema.String)).annotate({
		description:
			"Workspace-member recipients (`user_…` IDs) for `email` destinations; `null` for every other type.",
	}),
	last_tested_at: Schema.NullOr(Timestamp).annotate({
		description: "When a test notification was last sent to this destination, or `null` if never tested.",
	}),
	last_test_error: Schema.NullOr(Schema.String).annotate({
		description: "The failure message from the most recent test delivery, or `null` if it succeeded (or was never run).",
	}),
	created_at: Timestamp.annotate({ description: "When the destination was created." }),
	updated_at: Timestamp.annotate({ description: "When the destination was last updated." }),
}).annotate({
	identifier: "AlertDestination",
	title: "Alert Destination",
	description:
		"A notification channel that alert rules deliver to (Slack, PagerDuty, generic webhook, Hazel, Discord, or workspace-member email). Channel secrets are write-only: responses carry a redacted `summary` instead.",
	examples: [wireExample(alertDestinationExample)],
})
export type V2AlertDestination = Schema.Schema.Type<typeof V2AlertDestination>

// --- Create params: discriminated union on `type`, one arm per channel. ---

const enabledField = Schema.optionalKey(
	Schema.Boolean.annotate({
		description: "Whether the destination starts enabled. Defaults to `true`.",
		examples: [true],
	}),
)

const nameField = NonEmptyString.annotate({
	description: "Human-readable label for the destination. Required, non-empty.",
	examples: ["On-call Slack"],
})

const V2SlackDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("slack"),
	name: nameField,
	webhook_url: NonEmptyString.annotate({
		description: "The Slack incoming-webhook URL. Write-only — never returned.",
		examples: ["https://hooks.slack.com/services/T000/B000/XXXX"],
	}),
	channel_label: Schema.optionalKey(
		NonEmptyString.annotate({
			description: "Optional display label for the target channel, e.g. `#incidents`.",
			examples: ["#incidents"],
		}),
	),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreateSlack", title: "Slack destination" })

const V2PagerDutyDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("pagerduty"),
	name: nameField,
	integration_key: NonEmptyString.annotate({
		description: "The PagerDuty Events API v2 integration (routing) key. Write-only — never returned.",
	}),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreatePagerduty", title: "PagerDuty destination" })

const V2WebhookDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("webhook"),
	name: nameField,
	url: NonEmptyString.annotate({
		description: "The HTTPS endpoint that receives alert payloads as JSON POSTs.",
		examples: ["https://example.com/hooks/maple"],
	}),
	signing_secret: Schema.optionalKey(
		Schema.String.annotate({
			description: "Optional secret used to HMAC-sign webhook payloads. Write-only — never returned.",
		}),
	),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreateWebhook", title: "Webhook destination" })

const V2HazelDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("hazel"),
	name: nameField,
	webhook_url: NonEmptyString.annotate({
		description: "The Hazel inbound-webhook URL. Write-only — never returned.",
	}),
	signing_secret: Schema.optionalKey(
		Schema.String.annotate({
			description: "Optional secret used to sign payloads. Write-only — never returned.",
		}),
	),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreateHazel", title: "Hazel destination" })

const V2HazelOAuthDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("hazel-oauth"),
	name: nameField,
	hazel_organization_id: HazelOrganizationId.annotate({
		description: "The connected Hazel organization ID.",
	}),
	hazel_organization_name: NonEmptyString.annotate({
		description: "Display name of the connected Hazel organization.",
	}),
	hazel_organization_logo_url: Schema.optionalKey(
		Schema.NullOr(NonEmptyString).annotate({
			description: "Optional logo URL for the connected Hazel organization.",
		}),
	),
	hazel_channel_id: HazelChannelId.annotate({
		description: "The Hazel channel that receives notifications.",
	}),
	hazel_channel_name: NonEmptyString.annotate({
		description: "Display name of the Hazel channel.",
	}),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreateHazelOauth", title: "Hazel (OAuth) destination" })

const V2DiscordDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("discord"),
	name: nameField,
	webhook_url: NonEmptyString.annotate({
		description: "The Discord webhook URL. Write-only — never returned.",
	}),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreateDiscord", title: "Discord destination" })

const V2EmailDestinationCreateParams = Schema.Struct({
	type: Schema.Literal("email"),
	name: nameField,
	member_user_ids: MemberUserIdList.annotate({
		description: `Workspace-member recipients (\`user_…\` IDs), between 1 and ${MAX_EMAIL_RECIPIENTS}. The server resolves each to the member's email — arbitrary addresses cannot be targeted.`,
	}),
	enabled: enabledField,
}).annotate({ identifier: "AlertDestinationCreateEmail", title: "Email destination" })

export const V2AlertDestinationCreateParams = Schema.Union([
	V2SlackDestinationCreateParams,
	V2PagerDutyDestinationCreateParams,
	V2WebhookDestinationCreateParams,
	V2HazelDestinationCreateParams,
	V2HazelOAuthDestinationCreateParams,
	V2DiscordDestinationCreateParams,
	V2EmailDestinationCreateParams,
]).annotate({
	identifier: "AlertDestinationCreateParams",
	title: "Alert destination create parameters",
	description:
		"Request body for creating an alert destination, discriminated on `type`. Channel secrets are accepted here but never returned by any read endpoint.",
	examples: [
		wireExample({
			type: "slack",
			name: "On-call Slack",
			webhook_url: "https://hooks.slack.com/services/T000/B000/XXXX",
			channel_label: "#incidents",
			enabled: true,
		}),
	],
})
export type V2AlertDestinationCreateParams = Schema.Schema.Type<typeof V2AlertDestinationCreateParams>

// --- Update params: same discriminant, every config field optional. ---

const optionalNameField = Schema.optionalKey(
	NonEmptyString.annotate({ description: "New label for the destination." }),
)

export const V2AlertDestinationUpdateParams = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("slack"),
		name: optionalNameField,
		webhook_url: Schema.optionalKey(Schema.String),
		channel_label: OptionalNonEmptyString,
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdateSlack", title: "Slack destination update" }),
	Schema.Struct({
		type: Schema.Literal("pagerduty"),
		name: optionalNameField,
		integration_key: Schema.optionalKey(Schema.String),
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdatePagerduty", title: "PagerDuty destination update" }),
	Schema.Struct({
		type: Schema.Literal("webhook"),
		name: optionalNameField,
		url: Schema.optionalKey(Schema.String),
		signing_secret: Schema.optionalKey(Schema.String),
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdateWebhook", title: "Webhook destination update" }),
	Schema.Struct({
		type: Schema.Literal("hazel"),
		name: optionalNameField,
		webhook_url: Schema.optionalKey(Schema.String),
		signing_secret: Schema.optionalKey(Schema.String),
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdateHazel", title: "Hazel destination update" }),
	Schema.Struct({
		type: Schema.Literal("hazel-oauth"),
		name: optionalNameField,
		hazel_organization_id: Schema.optionalKey(HazelOrganizationId),
		hazel_organization_name: Schema.optionalKey(Schema.String),
		hazel_organization_logo_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
		hazel_channel_id: Schema.optionalKey(HazelChannelId),
		hazel_channel_name: Schema.optionalKey(Schema.String),
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdateHazelOauth", title: "Hazel (OAuth) destination update" }),
	Schema.Struct({
		type: Schema.Literal("discord"),
		name: optionalNameField,
		webhook_url: Schema.optionalKey(Schema.String),
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdateDiscord", title: "Discord destination update" }),
	Schema.Struct({
		type: Schema.Literal("email"),
		name: optionalNameField,
		member_user_ids: Schema.optionalKey(MemberUserIdList),
		enabled: Schema.optionalKey(Schema.Boolean),
	}).annotate({ identifier: "AlertDestinationUpdateEmail", title: "Email destination update" }),
]).annotate({
	identifier: "AlertDestinationUpdateParams",
	title: "Alert destination update parameters",
	description:
		"Request body for updating an alert destination. `type` must match the destination's existing (immutable) type and selects which config fields apply; omitted fields are left unchanged.",
	examples: [wireExample({ type: "slack", enabled: false })],
})
export type V2AlertDestinationUpdateParams = Schema.Schema.Type<typeof V2AlertDestinationUpdateParams>

export const V2AlertDestinationDeleteResponse = Schema.Struct({
	id: AlertDestinationPublicId,
	object: Schema.Literal("alert_destination").annotate({
		description: 'The object type — always `"alert_destination"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` — the destination no longer exists.",
	}),
}).annotate({
	identifier: "AlertDestinationDeleteResponse",
	title: "Alert destination delete response",
	description: "Confirmation that an alert destination was deleted.",
	examples: [
		wireExample({ id: "dest_oybbpTBhtSFGShMjjLiCrh", object: "alert_destination", deleted: true }),
	],
})
export type V2AlertDestinationDeleteResponse = Schema.Schema.Type<typeof V2AlertDestinationDeleteResponse>

export const V2AlertDestinationTestResult = Schema.Struct({
	object: Schema.Literal("alert_destination.test_result").annotate({
		description: 'The object type — always `"alert_destination.test_result"`.',
	}),
	success: Schema.Boolean.annotate({
		description: "Whether the test notification was delivered successfully.",
		examples: [true],
	}),
	message: Schema.String.annotate({
		description: "Human-readable delivery outcome.",
		examples: ["Test notification sent"],
	}),
}).annotate({
	identifier: "AlertDestinationTestResult",
	title: "Alert destination test result",
	description: "The outcome of sending a test notification to a destination.",
	examples: [
		wireExample({ object: "alert_destination.test_result", success: true, message: "Test notification sent" }),
	],
})
export type V2AlertDestinationTestResult = Schema.Schema.Type<typeof V2AlertDestinationTestResult>

const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const

const AlertDestinationList = ListOf(V2AlertDestination).annotate({
	identifier: "AlertDestinationList",
	title: "Alert destination list",
	description: "A cursor-paginated page of alert destinations.",
})

export class V2AlertDestinationsApiGroup extends HttpApiGroup.make("alertDestinations")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: AlertDestinationList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listAlertDestinations",
				summary: "List alert destinations",
				description:
					"Returns your organization's alert destinations, most recently created first. Cursor-paginated. Requires the `alert_destinations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2AlertDestinationCreateParams,
			success: V2AlertDestination,
			error: [...commonErrors, V2PermissionError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createAlertDestination",
				summary: "Create an alert destination",
				description:
					"Creates a notification channel that alert rules can deliver to. The request body is discriminated on `type`; channel secrets are write-only. Requires an org-admin role and the `alert_destinations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: AlertDestinationPublicId },
			success: V2AlertDestination,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getAlertDestination",
				summary: "Retrieve an alert destination",
				description:
					"Returns a single alert destination by its `dest_…` ID. Requires the `alert_destinations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: AlertDestinationPublicId },
			payload: V2AlertDestinationUpdateParams,
			success: V2AlertDestination,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateAlertDestination",
				summary: "Update an alert destination",
				description:
					"Updates a destination's configuration. `type` must match the destination's existing type; omitted fields are unchanged. Requires an org-admin role and the `alert_destinations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: AlertDestinationPublicId },
			success: V2AlertDestinationDeleteResponse,
			error: [...commonErrors, V2PermissionError, V2NotFoundError, V2ConflictError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteAlertDestination",
				summary: "Delete an alert destination",
				description:
					"Permanently deletes a destination. Fails with a `conflict_error` if any alert rule still references it — detach it from those rules first. Requires an org-admin role and the `alert_destinations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("test", "/:id/test", {
			params: { id: AlertDestinationPublicId },
			success: V2AlertDestinationTestResult,
			error: [...commonErrors, V2PermissionError, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "testAlertDestination",
				summary: "Test an alert destination",
				description:
					"Sends a test notification through the destination and reports the delivery outcome. Requires an org-admin role and the `alert_destinations:write` scope.",
			}),
		),
	)
	.prefix("/v2/alert_destinations")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Alert Destinations",
			description:
				"Notification channels for alert rules — Slack, PagerDuty, generic webhooks, Hazel, Discord, and workspace-member email. Create and manage destinations, then reference them from alert rules via `destination_ids`. Mutations are admin-only; channel secrets are write-only.",
		}),
	) {}
