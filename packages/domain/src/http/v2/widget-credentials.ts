import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ApiKeyPersistenceError } from "../api-keys"
import { OrgId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { publicError } from "./public-error"

/**
 * The credential a device's Home Screen widgets fetch with.
 *
 * A widget extension holds no session: session tokens are minted with a
 * one-minute TTL, and two processes refreshing the same rotating refresh token
 * is a way to sign the user out. So the app — which does hold the session —
 * asks for a long-lived credential *on the installation's behalf*, and the
 * widget uses that.
 *
 * **Its own resource family, not a sub-resource of `/v2/mobile_devices`.** The
 * obvious home looked like the device that push registration already
 * establishes, but a device row is keyed on an APNs token, and a user who
 * declines notifications has none. Widgets and notifications are separate
 * permissions, and someone who wants one and not the other is completely
 * ordinary — hanging the credential off push would have quietly meant "no
 * widget refresh unless you also accept alerts". The installation identifies
 * itself instead.
 *
 * Everything that bounds the credential is chosen by the server, which is why
 * this is a dedicated operation rather than `POST /v2/api_keys` with a `kind`:
 * the caller names an installation and nothing else, so it cannot ask for wider
 * scopes, a longer life, or more authority than the person running the app.
 */
export const InstallationId = Schema.String.check(
	Schema.isMinLength(8),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[A-Za-z0-9_-]+$/, {
		description: "an opaque installation identifier (letters, digits, `_` and `-`)",
	}),
).annotate({
	title: "Installation ID",
	description:
		"A stable, client-generated identifier for one app installation — on iOS, `identifierForVendor`. Opaque to Maple, and only ever compared against itself: it decides which credential a re-mint replaces.",
	examples: ["F9E1B4C0-8F2A-4C6D-9E1B-4C08F2A4C6D9"],
})

export const V2WidgetCredential = Schema.Struct({
	object: Schema.Literal("widget_credential").annotate({
		description: 'The object type — always `"widget_credential"`.',
	}),
	/**
	 * Returned **once**, at mint. Maple stores only a hash, so a caller that
	 * loses this mints again — one call, and what the app does anyway when the
	 * credential nears expiry.
	 */
	secret: Schema.String.annotate({
		description:
			"The bearer token, shown once. Store it where only this installation can read it, and send it nowhere but Maple.",
	}),
	/** The organization it is bound to. An API key cannot select another. */
	organization_id: OrgId,
	scopes: Schema.Array(Schema.String).annotate({
		description: "Fixed by the server. Today, exactly `widget_summary:read`.",
	}),
	expires_at: Timestamp.annotate({
		description:
			"When the credential stops working. The app re-mints well before this; a widget that reaches it renders its last snapshot and waits for the app.",
	}),
	created_at: Timestamp,
}).annotate({
	identifier: "WidgetCredential",
	title: "Widget credential",
	description:
		"A read-only, expiring credential for one app installation's Home Screen widgets. Minting is idempotent per installation: the previous credential is revoked in the same transaction.",
	examples: [
		wireExample({
			object: "widget_credential",
			secret: "maple_ak_1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
			organization_id: "org_2abcDEF",
			scopes: ["widget_summary:read"],
			expires_at: "2026-09-20T09:10:00.000Z",
			created_at: "2026-08-21T09:10:00.000Z",
		}),
	],
})
export type V2WidgetCredential = Schema.Schema.Type<typeof V2WidgetCredential>

export const V2WidgetCredentialDeleteResponse = Schema.Struct({
	object: Schema.Literal("widget_credential"),
	deleted: Schema.Literal(true),
}).annotate({
	identifier: "WidgetCredentialDeleteResponse",
	title: "Widget credential delete response",
})

export class V2WidgetCredentialsApiGroup extends HttpApiGroup.make("widgetCredentials")
	.add(
		HttpApiEndpoint.put("mint", "/:installation_id", {
			params: { installation_id: InstallationId },
			success: V2WidgetCredential,
			error: [publicError(ApiKeyPersistenceError)],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "mintWidgetCredential",
				summary: "Mint this installation's widget credential",
				description:
					"Issues a read-only, expiring credential for this installation's Home Screen widgets, revoking whatever it had. Idempotent, so the app calls it again to roll. Requires the `widget_credentials:write` scope — which a widget credential does not have, so renewal always goes through a signed-in session.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("revoke", "/:installation_id", {
			params: { installation_id: InstallationId },
			success: V2WidgetCredentialDeleteResponse,
			error: [publicError(ApiKeyPersistenceError)],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "revokeWidgetCredential",
				summary: "Revoke this installation's widget credential",
				description:
					"Retires the installation's credential for this organization; the app calls this on sign-out and when the user leaves the organization. Idempotent — an installation with nothing to revoke is already in the requested state. Requires the `widget_credentials:write` scope.",
			}),
		),
	)
	.prefix("/v2/widget_credentials")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Widget Credentials",
			description:
				"Device-scoped, read-only credentials for the Maple mobile Home Screen widgets. Minted by a signed-in app for one installation at a time.",
		}),
	) {}
