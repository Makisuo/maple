import { Schema } from "effect"

// Onboarding state has no HTTP surface: the v1 `/api/onboarding` group was
// retired once the quick-start wizard moved to client-local state. These
// schemas stay because `OnboardingService` and `SetupAuditService` use them.

export class OnboardingStateResponse extends Schema.Class<OnboardingStateResponse>("OnboardingStateResponse")(
	{
		role: Schema.NullOr(Schema.String),
		demoDataRequested: Schema.Boolean,
		onboardingCompletedAt: Schema.NullOr(Schema.Number),
		checklistDismissedAt: Schema.NullOr(Schema.Number),
		firstDataReceivedAt: Schema.NullOr(Schema.Number),
		createdAt: Schema.Number,
		updatedAt: Schema.Number,
	},
) {}

export class UpdateOnboardingStateRequest extends Schema.Class<UpdateOnboardingStateRequest>(
	"UpdateOnboardingStateRequest",
)({
	role: Schema.optionalKey(Schema.String),
	demoDataRequested: Schema.optionalKey(Schema.Boolean),
	markOnboardingComplete: Schema.optionalKey(Schema.Boolean),
	markChecklistDismissed: Schema.optionalKey(Schema.Boolean),
}) {}

export class OnboardingPersistenceError extends Schema.TaggedError<OnboardingPersistenceError>()(
	"@maple/http/errors/OnboardingPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}
