import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { Timestamp } from "./envelopes"
import { V2NotFoundError, V2PermissionError, V2ServiceUnavailableError, V2UpstreamError } from "./errors"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

// Slack integration. A workspace installs the Maple Slack app via OAuth; the
// resulting bot token + minted Maple API key are stored server-side (see the
// `slack_workspaces` table). These endpoints drive the dashboard's Slack
// integration card: kick off the install, read status, uninstall, and list
// channels the bot can post to.
//
// Why this file exists here, given `http/integrations.ts` already covers
// Cloudflare/PlanetScale/GitHub/Hazel:
//
//   - It is a *contract*, not an implementation. `apps/web` derives its typed
//     client straight from `MapleApiV2` (`MapleApiV2AtomClient`), so the group
//     has to live in a package both the browser and the Worker can import.
//     Handlers stay in `apps/api/src/routes/v2/integrations.http.ts`. This is
//     the split the "Adding a v2 resource" checklist in docs/api-v2.md
//     prescribes, and all twenty v2 groups follow it — nothing about Slack is
//     special. `http/integrations.ts` is shared for the same reason; it is just
//     the v1 tier.
//   - Slack is the first integration built after the v2 migration started, so
//     it goes straight onto v2 rather than extending a v1 group that is slated
//     for deletion. The older providers stay on v1 until something public needs
//     them — PlanetScale reached that point and now lives in
//     `integrations-planetscale.ts` (its v1 endpoints stay mounted, deprecated,
//     until external callers drain); Cloudflare, GitHub, and Hazel have not.
//   - It is public rather than internal because `/v2/alerts/destinations`
//     accepts `type: "slack-bot"` with a required `channel_id` and the bot token
//     never leaves the server: `GET /v2/integrations/slack/channels` is the only
//     way any caller can discover a valid id.
//
// The OAuth *callback* is deliberately not here — Slack redirects a browser, so
// it is a raw router in `apps/api/src/routes/slack-integration.http.ts` that
// 302s back to the web app. Same for the service-to-service bot-resolution
// endpoint the Slack agent calls.
//
// One file per provider (`integrations.ts` is Slack's, despite the name;
// `integrations-planetscale.ts` is PlanetScale's). Scope families are derived
// from the first path segment under `/v2`, so every `/v2/integrations/<provider>`
// group shares the `integrations:read` / `integrations:write` family no matter
// which file it is declared in — the split is about file size, nothing else.

export const V2SlackIntegrationStatus = Schema.Struct({
	object: Schema.Literal("slack_integration").annotate({
		description: 'The object type — always `"slack_integration"`.',
		examples: ["slack_integration"],
	}),
	installed: Schema.Boolean.annotate({
		description: "Whether the Maple Slack app is currently installed for this organization.",
		examples: [true],
	}),
	team_id: Schema.NullOr(Schema.String).annotate({
		description: "The connected Slack workspace (team) id, or `null` when not installed.",
		examples: ["T0123ABCD"],
	}),
	team_name: Schema.NullOr(Schema.String).annotate({
		description: "The connected Slack workspace name, or `null`.",
		examples: ["Acme"],
	}),
	bot_user_id: Schema.NullOr(Schema.String).annotate({
		description: "The Slack user id of the installed bot, or `null`.",
		examples: ["U0456BOT"],
	}),
	installed_at: Schema.NullOr(Timestamp).annotate({
		description: "When the app was installed, or `null` when not installed.",
	}),
	disconnected_reason: Schema.NullOr(
		Schema.Literals(["app_uninstalled", "tokens_revoked", "reconciliation"]),
	).annotate({
		description:
			"Set only when `installed` is `false` and the most recent installation was disconnected from Slack's side rather than via Maple: `app_uninstalled` (the app was removed from the workspace), `tokens_revoked` (Slack revoked the bot's tokens), or `reconciliation` (Maple found the bot token dead). `null` when installed, never installed, or uninstalled via Maple.",
		examples: ["app_uninstalled"],
	}),
	disconnected_team_name: Schema.NullOr(Schema.String).annotate({
		description:
			"The workspace name of the remotely disconnected installation, or `null` when `disconnected_reason` is `null`.",
		examples: ["Acme"],
	}),
	disconnected_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the remote disconnect was recorded, or `null` when `disconnected_reason` is `null`.",
	}),
	missing_scopes: Schema.Array(Schema.String).annotate({
		description:
			"Bot scopes Maple now requires that the current installation has not granted. Non-empty means the app should be reconnected (a fresh OAuth install over the existing one) to pick up the new permissions — the bot keeps its channel memberships. Always empty when not installed.",
		examples: [["reactions:write"]],
	}),
}).annotate({
	identifier: "SlackIntegration",
	title: "Slack integration status",
	description: "The Slack app installation state for the authenticated organization.",
	examples: [
		wireExample({
			object: "slack_integration",
			installed: true,
			team_id: "T0123ABCD",
			team_name: "Acme",
			bot_user_id: "U0456BOT",
			installed_at: "2026-07-01T12:00:00.000Z",
			disconnected_reason: null,
			disconnected_team_name: null,
			disconnected_at: null,
			missing_scopes: [],
		}),
	],
})
export type V2SlackIntegrationStatus = Schema.Schema.Type<typeof V2SlackIntegrationStatus>

export const V2SlackInstallResponse = Schema.Struct({
	object: Schema.Literal("slack_integration.install").annotate({
		description: 'The object type — always `"slack_integration.install"`.',
	}),
	url: Schema.String.annotate({
		description:
			"The Slack authorize URL to redirect the user to. Opens the Slack consent screen; on approval Slack redirects back to Maple's callback.",
		examples: ["https://slack.com/oauth/v2/authorize?client_id=..."],
	}),
}).annotate({
	identifier: "SlackInstall",
	title: "Slack install response",
	description: "The Slack OAuth authorize URL to begin an installation.",
	examples: [
		wireExample({
			object: "slack_integration.install",
			url: "https://slack.com/oauth/v2/authorize?client_id=123&scope=chat:write&state=abc",
		}),
	],
})
export type V2SlackInstallResponse = Schema.Schema.Type<typeof V2SlackInstallResponse>

export const V2SlackUninstallResponse = Schema.Struct({
	object: Schema.Literal("slack_integration").annotate({
		description: 'The object type — always `"slack_integration"`.',
	}),
	installed: Schema.Literal(false).annotate({
		description: "Always `false` — the app is no longer installed.",
	}),
}).annotate({
	identifier: "SlackUninstall",
	title: "Slack uninstall response",
	description: "Confirmation that the Slack app was uninstalled.",
	examples: [wireExample({ object: "slack_integration", installed: false })],
})
export type V2SlackUninstallResponse = Schema.Schema.Type<typeof V2SlackUninstallResponse>

export const V2SlackChannel = Schema.Struct({
	id: Schema.String.annotate({ description: "The Slack channel id.", examples: ["C0789CHAN"] }),
	name: Schema.String.annotate({ description: "The channel name (without `#`).", examples: ["incidents"] }),
	is_private: Schema.Boolean.annotate({
		description: "Whether the channel is private.",
		examples: [false],
	}),
	is_member: Schema.Boolean.annotate({
		description:
			"Whether the Maple bot is a member of the channel (required to post to private channels).",
		examples: [true],
	}),
}).annotate({
	identifier: "SlackChannel",
	title: "Slack channel",
	description: "A channel the installed Maple Slack bot can see.",
	examples: [wireExample({ id: "C0789CHAN", name: "incidents", is_private: false, is_member: true })],
})
export type V2SlackChannel = Schema.Schema.Type<typeof V2SlackChannel>

export const V2SlackChannelList = Schema.Struct({
	object: Schema.Literal("slack_integration.channel_list").annotate({
		description: 'The object type — always `"slack_integration.channel_list"`.',
	}),
	channels: Schema.Array(V2SlackChannel).annotate({
		description:
			"The channels the installed bot can see, ordered with the channels the bot has joined (`is_member`) first, then alphabetically by name within each half.",
	}),
	truncated: Schema.Boolean.annotate({
		description:
			"Whether the workspace has more channels than this response could reach. `true` means `channels` is a prefix of the inventory, not the whole of it — the bot must be invited to a missing channel for it to appear.",
		examples: [false],
	}),
}).annotate({
	identifier: "SlackChannelList",
	title: "Slack channel list",
	description:
		'The channels visible to the installed Slack bot. Note: unlike every other v2 collection this response is **not** the standard `{ object: "list", data, has_more, next_cursor }` envelope — Maple walks Slack\'s `conversations.list` cursors server-side and returns the set in one response, so there is no cursor for a client to follow. The walk is page-capped; `truncated` reports whether it hit that cap.',
	examples: [
		wireExample({
			object: "slack_integration.channel_list",
			channels: [{ id: "C0789CHAN", name: "incidents", is_private: false, is_member: true }],
			truncated: false,
		}),
	],
})
export type V2SlackChannelList = Schema.Schema.Type<typeof V2SlackChannelList>

// Declared per endpoint rather than from a shared `commonErrors` tuple: the
// handlers in apps/api/src/routes/v2/integrations.http.ts each map a small,
// fixed set of service failures, and a wider list would publish responses the
// API can never return. 400/401/403/429/503 come from the middleware.
export class V2SlackIntegrationsApiGroup extends HttpApiGroup.make("slackIntegration")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: V2SlackIntegrationStatus,
			error: [V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSlackIntegration",
				summary: "Retrieve Slack integration status",
				description:
					"Returns whether the Maple Slack app is installed for your organization. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("install", "/install", {
			success: V2SlackInstallResponse,
			error: [V2ServiceUnavailableError, V2PermissionError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "installSlackIntegration",
				summary: "Begin a Slack installation",
				description:
					"Returns a Slack OAuth authorize URL to redirect the user to. Also the way to reconnect an existing installation (e.g. to grant newly required scopes): re-approving updates the installation in place without removing the bot from its channels. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("uninstall", "/", {
			success: V2SlackUninstallResponse,
			error: [V2ServiceUnavailableError, V2PermissionError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "uninstallSlackIntegration",
				summary: "Uninstall the Slack app",
				description:
					"Revokes the Slack installation and the API key minted for the bot. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("channels", "/channels", {
			success: V2SlackChannelList,
			error: [V2ServiceUnavailableError, V2NotFoundError, V2UpstreamError, V2PermissionError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listSlackChannels",
				summary: "List Slack channels",
				description:
					"Lists the channels the installed Maple bot can see — including private channels the bot has been invited to. Requires an org-admin role and the `integrations:read` scope.",
			}),
		),
	)
	.prefix("/v2/integrations/slack")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Slack Integration",
			description:
				"Install and manage the Maple Slack app for your organization: begin an OAuth install, read installation status, list channels, and uninstall.",
		}),
	) {}
