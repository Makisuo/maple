import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { OrgId } from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2ServiceUnavailableError } from "./errors"

/** See api-keys.ts: examples are authored in wire (encoded) shape. */
const wireExample = <A>(example: object): A => example as A

/**
 * Clerk `org_…` IDs are already opaque public IDs — they pass through the v2
 * boundary unchanged (unlike internal UUIDs, they are NOT wrapped with `PublicId`).
 */
const OrganizationPublicId = OrgId.annotate({
	title: "Organization ID",
	description: "The organization's opaque `org_…` ID (e.g. `org_2abcDEF`).",
})

export const V2Organization = Schema.Struct({
	id: OrganizationPublicId,
	object: Schema.Literal("organization").annotate({
		description: 'The object type — always `"organization"`.',
		examples: ["organization"],
	}),
	name: Schema.NullOr(Schema.String).annotate({
		description: "The organization's display name, or `null` in self-hosted mode.",
		examples: ["Acme Inc"],
	}),
	slug: Schema.NullOr(Schema.String).annotate({
		description: "The organization's URL slug, or `null` when unset or in self-hosted mode.",
		examples: ["acme"],
	}),
	created_at: Schema.NullOr(Timestamp).annotate({
		description: "When the organization was created, or `null` in self-hosted mode.",
	}),
}).annotate({
	identifier: "Organization",
	title: "Organization",
	description:
		"The authenticated organization. Identity is sourced from the auth provider; in self-hosted mode only the `id` is populated.",
	examples: [
		wireExample({
			id: "org_2abcDEF",
			object: "organization",
			name: "Acme Inc",
			slug: "acme",
			created_at: "2026-01-15T12:00:00.000Z",
		}),
	],
})
export type V2Organization = Schema.Schema.Type<typeof V2Organization>

export class V2OrganizationApiGroup extends HttpApiGroup.make("organization")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2Organization,
			error: [V2InvalidRequestError, V2ServiceUnavailableError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getOrganization",
				summary: "Retrieve the organization",
				description:
					"Returns the organization the credentials belong to. Requires the `organization:read` scope.",
			}),
		),
	)
	.prefix("/v2/organization")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Organization",
			description: "The authenticated organization's identity.",
		}),
	) {}
