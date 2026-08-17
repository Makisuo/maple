import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

export class DeleteOrganizationResponse extends Schema.Class<DeleteOrganizationResponse>(
	"DeleteOrganizationResponse",
)({
	deleted: Schema.Literal(true),
}) {}

export class OrganizationForbiddenError extends HttpTaggedError<OrganizationForbiddenError>()(
	"@maple/http/errors/OrganizationForbiddenError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "organization_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class OrganizationPersistenceError extends HttpTaggedError<OrganizationPersistenceError>()(
	"@maple/http/errors/OrganizationPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "organization_persistence_unavailable",
		title: "Organization storage is temporarily unavailable",
		message: "Organization storage is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class OrganizationProviderError extends HttpTaggedError<OrganizationProviderError>()(
	"@maple/http/errors/OrganizationProviderError",
	{
		message: Schema.String,
	},
	{
		status: 502,
		code: "organization_provider_unavailable",
		title: "Organization provider unavailable",
		message: "The organization provider is temporarily unavailable.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class OrganizationsApiGroup extends HttpApiGroup.make("organizations")
	.add(
		HttpApiEndpoint.delete("delete", "/", {
			success: DeleteOrganizationResponse,
			error: [OrganizationForbiddenError, OrganizationPersistenceError, OrganizationProviderError],
		}),
	)
	.prefix("/api/organizations")
	.middleware(Authorization) {}
