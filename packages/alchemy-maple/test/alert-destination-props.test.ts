/**
 * The `AlertDestination` constructor must keep its discriminated union.
 *
 * Alchemy types props as `InputProps<Props>`, a mapped type that collapses a
 * union to the keys its members share — which erased every channel-specific
 * field and made the resource uncallable. The declared call signature restores
 * it; these compile-time assertions are how we notice if it regresses (a stale
 * `@ts-expect-error` fails as TS2578). Wire bodies are covered by contract.test.
 */
import { Effect } from "effect"
import { expect, it } from "vitest"
import { AlertDestination } from "../src/AlertDestination"

// Every declaratively provisionable channel is constructible with its own fields.
export const accepts = Effect.gen(function* () {
	yield* AlertDestination("pagerduty", { type: "pagerduty", name: "p", integration_key: "k" })
	yield* AlertDestination("webhook", { type: "webhook", name: "w", url: "https://x", signing_secret: "s" })
	yield* AlertDestination("discord", { type: "discord", name: "d", webhook_url: "u" })
	yield* AlertDestination("telegram", {
		type: "telegram",
		name: "t",
		bot_token: "123456789:AAtoken",
		chat_id: "-1001234567890",
	})
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
	// @ts-expect-error telegram requires chat_id alongside the token
	yield* AlertDestination("d", { type: "telegram", name: "x", bot_token: "123456789:AAtoken" })
})

it("keeps the compile-time destination examples", () => {
	expect(accepts).toBeDefined()
	expect(rejects).toBeDefined()
})
