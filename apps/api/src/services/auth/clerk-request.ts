import { Effect, Schema } from "effect"

export class ClerkRequestError extends Schema.TaggedError<ClerkRequestError>()(
	"@maple/api/services/auth/ClerkRequestError",
	{
		operation: Schema.String,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

type ClerkSpanAttributes = Readonly<Record<string, string | number | boolean>>

/**
 * Lift a Clerk SDK request into Effect with the Client-kind span attributes
 * required for Maple's service map. Callers map the internal request error to
 * their own service contract at the boundary.
 */
export const clerkRequest = <A>(
	spanName: string,
	attributes: ClerkSpanAttributes,
	request: () => Promise<A>,
): Effect.Effect<A, ClerkRequestError> =>
	Effect.tryPromise({
		try: request,
		catch: (cause) =>
			new ClerkRequestError({
				operation: spanName,
				message: cause instanceof Error ? cause.message : "Clerk request failed",
				cause,
			}),
	}).pipe(
		Effect.withSpan(spanName, {
			kind: "client",
			attributes: { "peer.service": "clerk", ...attributes },
		}),
	)
