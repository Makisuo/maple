import { Effect } from "effect"
import { buildAlertEmailContent } from "../../alert-email"
import { makeDeliveryError } from "../runTransport"
import type { EffectTransport, EffectTransportDeps, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"email">

/**
 * The one non-HTTP provider: it fans out over the destination's workspace
 * members through the platform email channel.
 *
 * Custom notification templates are deliberately not consulted — HTML email
 * cannot safely render arbitrary user Markdown — so email always uses the
 * built-in format.
 */
export const emailTransport: EffectTransport<Config> = {
	kind: "effect",
	type: "email",
	peerService: "email",
	providerLabel: "Email",
	send: (input: RenderInput<Config>, deps: EffectTransportDeps) =>
		Effect.gen(function* () {
			const { subject, html } = yield* buildAlertEmailContent(
				input.context,
				input.linkUrl,
				input.chatUrl,
			)
			const members = input.config.members
			const outcomes = yield* Effect.forEach(members, (member) =>
				deps.sendEmail(member.email, subject, html).pipe(
					Effect.match({
						onSuccess: () => ({ member, error: null as string | null }),
						onFailure: (error) => ({ member, error: error.message }),
					}),
				),
			)
			const failures = outcomes.filter((outcome) => outcome.error != null)
			const count = members.length

			if (failures.length === count && count > 0) {
				// Nobody received it — safe to fail retryable; the retry re-sends to
				// members who all got nothing. Keep the first failure message
				// verbatim so timeout classification survives the aggregation.
				return yield* Effect.fail(
					makeDeliveryError(
						`Email delivery failed for all ${count} member${count === 1 ? "" : "s"}: ${failures[0]!.error}`,
						"email",
					),
				)
			}

			if (failures.length > 0) {
				// Partial success is TERMINAL: there is no per-member attempt state,
				// so retrying would re-email the members who already received it.
				// Report success and surface the failures.
				yield* Effect.annotateCurrentSpan({ "maple.delivery.degraded": true })
				yield* Effect.logWarning("Alert email delivered to a subset of members").pipe(
					Effect.annotateLogs({
						failedCount: failures.length,
						memberCount: count,
						firstError: failures[0]!.error,
					}),
				)
				return {
					providerMessage: `Emailed ${count - failures.length} of ${count} members; failed: ${failures
						.map((failure) => `${failure.member.email} (${failure.error})`)
						.join(", ")}`,
					providerReference: null,
					responseCode: null,
				}
			}

			return {
				providerMessage: `Emailed ${count} member${count === 1 ? "" : "s"}`,
				providerReference: null,
				responseCode: null,
			}
		}),
}
