import { assert, describe, it } from "@effect/vitest"
import { Effect, Tracer } from "effect"
import { ClerkRequestError, clerkRequest } from "./clerk-request"

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("clerkRequest", () => {
	it.effect("emits a Client-kind Clerk span with tenant attributes", () =>
		Effect.gen(function* () {
			const { spans, tracer } = makeRecordingTracer()

			const value = yield* clerkRequest(
				"Clerk.organizations.getOrganization",
				{ orgId: "org_test" },
				() => Promise.resolve("Maple"),
			).pipe(Effect.withTracer(tracer))

			assert.strictEqual(value, "Maple")
			const span = spans.find((candidate) => candidate.name === "Clerk.organizations.getOrganization")
			assert.isDefined(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("peer.service"), "clerk")
			assert.strictEqual(span.attributes.get("orgId"), "org_test")
		}),
	)

	it.effect("maps rejected SDK promises to a typed request error", () =>
		Effect.gen(function* () {
			const result = yield* clerkRequest("Clerk.users.getUser", {}, () =>
				Promise.reject(new Error("unavailable")),
			).pipe(Effect.result)

			assert.isTrue(result._tag === "Failure")
			if (result._tag === "Failure") {
				assert.instanceOf(result.failure, ClerkRequestError)
				assert.strictEqual(result.failure.operation, "Clerk.users.getUser")
			}
		}),
	)
})
