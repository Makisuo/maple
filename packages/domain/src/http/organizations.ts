import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export class DeleteOrganizationResponse extends Schema.Class<DeleteOrganizationResponse>(
	"DeleteOrganizationResponse",
)({
	deleted: Schema.Literal(true),
}) {}

export class OrganizationForbiddenError extends Schema.TaggedErrorClass<OrganizationForbiddenError>()(
	"@maple/http/errors/OrganizationForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class OrganizationPersistenceError extends Schema.TaggedErrorClass<OrganizationPersistenceError>()(
	"@maple/http/errors/OrganizationPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class OrganizationProviderError extends Schema.TaggedErrorClass<OrganizationProviderError>()(
	"@maple/http/errors/OrganizationProviderError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 502 },
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
