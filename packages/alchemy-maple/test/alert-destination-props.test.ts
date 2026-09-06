/**
 * The `AlertDestination` constructor must keep its discriminated union.
 *
 * Preserve variant-specific fields while accepting Alchemy inputs for URLs,
 * credentials and other fields. A stale `@ts-expect-error` fails typechecking.
 */
import { Config, Effect } from "effect"
import type { Output } from "alchemy/Output"
import { expect, it } from "vitest"
import { AlertDestination } from "../src/AlertDestination"

export const acceptsOutputs = (url: Output<string>, secret: Output<string>) =>
	AlertDestination("hook", {
		type: "webhook",
		name: Config.string("HOOK_NAME"),
		url,
		signing_secret: secret,
	})

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
