import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export class OnboardingStateResponse extends Schema.Class<OnboardingStateResponse>(
	"OnboardingStateResponse",
)({
	role: Schema.NullOr(Schema.String),
	demoDataRequested: Schema.Boolean,
	onboardingCompletedAt: Schema.NullOr(Schema.Number),
	checklistDismissedAt: Schema.NullOr(Schema.Number),
	firstDataReceivedAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class UpdateOnboardingStateRequest extends Schema.Class<UpdateOnboardingStateRequest>(
	"UpdateOnboardingStateRequest",
)({
	role: Schema.optional(Schema.String),
	demoDataRequested: Schema.optional(Schema.Boolean),
	markOnboardingComplete: Schema.optional(Schema.Boolean),
	markChecklistDismissed: Schema.optional(Schema.Boolean),
}) {}

export class OnboardingPersistenceError extends Schema.TaggedErrorClass<OnboardingPersistenceError>()(
	"@maple/http/errors/OnboardingPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class OnboardingApiGroup extends HttpApiGroup.make("onboarding")
	.add(
		HttpApiEndpoint.get("getState", "/", {
			success: OnboardingStateResponse,
			error: OnboardingPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("updateState", "/", {
			payload: UpdateOnboardingStateRequest,
			success: OnboardingStateResponse,
			error: OnboardingPersistenceError,
		}),
	)
	.prefix("/api/onboarding")
	.middleware(Authorization) {}
