/**
 * The `AlertDestination` constructor must keep its discriminated union.
 *
 * Alchemy types props as `InputProps<Props>`, a mapped type that collapses a
 * union to the keys its members share — which erased every channel-specific
 * field and made the resource uncallable. The declared call signature restores
 * it; these assertions are how we notice if it regresses. The compile-time half
 * is enforced by `tsc` (a stale `@ts-expect-error` fails as TS2578), the runtime
 * half by the create bodies below.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
	AlertDestination,
	_alertDestinationCreateBody,
	type AlertDestinationProps,
} from "../src/AlertDestination"

// Every channel type is constructible with its own fields.
export const accepts = Effect.gen(function* () {
	yield* AlertDestination("pagerduty", { type: "pagerduty", name: "p", integration_key: "k" })
	yield* AlertDestination("webhook", { type: "webhook", name: "w", url: "https://x", signing_secret: "s" })
	yield* AlertDestination("discord", { type: "discord", name: "d", webhook_url: "u" })
	yield* AlertDestination("email", { type: "email", name: "e", member_user_ids: ["u_1"] })
})

// …and only with its own fields.
export const rejects = Effect.gen(function* () {
	// @ts-expect-error pagerduty requires integration_key
	yield* AlertDestination("a", { type: "pagerduty", name: "no secret" })
	// @ts-expect-error url belongs to webhook
	yield* AlertDestination("b", { type: "pagerduty", name: "x", integration_key: "k", url: "u" })
	// @ts-expect-error email requires member_user_ids
	yield* AlertDestination("c", { type: "email", name: "x" })
})

const channels: ReadonlyArray<[string, AlertDestinationProps, string]> = [
	["pagerduty", { type: "pagerduty", name: "p", integration_key: "k" }, "integration_key"],
	["webhook", { type: "webhook", name: "w", url: "https://x" }, "url"],
	["discord", { type: "discord", name: "d", webhook_url: "u" }, "webhook_url"],
	["email", { type: "email", name: "e", member_user_ids: ["u_1"] }, "member_user_ids"],
]

describe("alert destination create bodies carry the channel's own fields", () => {
	it.each(channels)("%s", (_label, props, field) => {
		expect(_alertDestinationCreateBody(props)).toHaveProperty(field)
	})
})
