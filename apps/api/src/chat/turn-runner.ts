/**
 * Running one chat turn, inside the `ChatSession` Durable Object.
 *
 * This module is the heavy half of the DO: the Effect runtime, the app service graph and
 * `@maple/llm`. `ChatSession.ts` reaches it through a dynamic import for the same reason
 * `worker.ts` dynamic-imports its route graph — the static graph builds hundreds of Schema ASTs at
 * module scope, which would blow Cloudflare's ~1s startup-CPU budget (error 10021) on a class that
 * is exported from the worker entry.
 *
 * Two things changed shape when the turn moved in here:
 *
 *   - **Appends are method calls.** The turn used to run in the request that submitted the message
 *     and write back over the DO stub, one RPC per token delta. It now holds the object itself.
 *   - **`submit_diagnosis` resolves itself.** It used to be threaded in as a callback from three
 *     call sites, because `InvestigationService` starting an investigation's own turn would have
 *     made the service require itself through the Effect requirements channel. Here the turn builds
 *     its *own* runtime, so it just resolves `InvestigationService` — no cycle, and no
 *     `env: workerEnv ?? {}` fallback silently degrading the model config when a caller forgot to
 *     thread the worker env through.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import type { ChatMessage, ChatTurnTenant } from "@maple/domain/chat-session"
import { layerFromEnvRecord, WorkerConfigProviderLayer } from "@maple/effect-cloudflare"
import { Message } from "@maple/llm"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { ChatSession } from "./ChatSession"
import type { TenantContext } from "@/services/auth/tenant-context"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

export interface RunChatSessionTurnInput {
	/** The Durable Object itself. Appends are direct calls, not stub RPC. */
	readonly session: ChatSession
	readonly sessionId: string
	readonly env: Record<string, unknown>
	readonly messageId: string
	readonly tenant: ChatTurnTenant
}

/**
 * Widen the wire projection back into the `apps/api` tenant type.
 *
 * `ChatTurnTenant` exists because the DO boundary needs a declared serializable shape; the fields
 * are the same branded primitives, so this is a shape widening (`ReadonlyArray` → array), not a
 * revalidation.
 */
const toTenantContext = (tenant: ChatTurnTenant): TenantContext => ({
	orgId: tenant.orgId,
	userId: tenant.userId,
	roles: [...tenant.roles],
	authMode: tenant.authMode,
	...(tenant.actorId === undefined ? {} : { actorId: tenant.actorId }),
})

/**
 * Project the durable transcript into `@maple/llm` messages.
 *
 * Tool calls are deliberately NOT replayed as tool messages: a rehydrated conversation needs the
 * *conclusions*, not a second copy of every tool payload, and replaying tool results without their
 * matching provider-native call ids is what makes providers reject a continuation. The assistant's
 * text is what carries forward.
 */
const toLlmMessages = (history: ReadonlyArray<ChatMessage>): ReadonlyArray<Message> =>
	history
		.filter((message) => message.text.trim() !== "")
		.map((message) =>
			message.role === "user" ? Message.user(message.text) : Message.assistant(message.text),
		)

/**
 * Drive one turn to completion.
 *
 * Resolves as a promise because the caller is a Durable Object method, not an Effect. Failures are
 * recorded into the log as a terminal event rather than propagated: the log is the only thing the
 * client reads, so a turn that dies without one is indistinguishable from a turn that hung.
 */
export const runChatSessionTurn = async (input: RunChatSessionTurnInput): Promise<void> => {
	const [{ MainLive }, { layerPg }, { layerLlm, resolveTriageModel }, agent] = await Promise.all([
		import("../app"),
		import("../platform/DatabasePgLive"),
		import("../platform/Llm"),
		import("./agent"),
	])
	const { InvestigationService } = await import("@/services/errors/InvestigationService")

	const runtime = ManagedRuntime.make(
		MainLive.pipe(
			Layer.provideMerge(layerLlm(input.env)),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(layerFromEnvRecord(input.env)),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	)

	const tenant = toTenantContext(input.tenant)

	const program = Effect.gen(function* () {
		const investigations = yield* InvestigationService
		const history = input.session.history()
		const extraTools = agent.buildSubmitDiagnosisTool(
			input.sessionId,
			tenant,
			investigations.submitDiagnosis,
		)

		yield* agent
			.runChatTurn({
				sessionId: input.sessionId,
				tenant,
				model: resolveTriageModel(input.env),
				messages: toLlmMessages(history),
				messageId: input.messageId,
				extraTools,
				// An abort clears the claim; the turn notices here and stops at the next event
				// rather than streaming into a conversation that has moved on.
				isCurrent: () => input.session.holdsTurn(input.messageId),
			})
			.pipe(
				Stream.takeWhile(() => input.session.holdsTurn(input.messageId)),
				Stream.runForEach((event) => Effect.sync(() => input.session.append(event))),
			)
	}).pipe(
		Effect.withSpan("chat.turn", {
			attributes: {
				orgId: tenant.orgId,
				"maple.chat.session": input.sessionId,
				"maple.chat.message_id": input.messageId,
			},
		}),
	)

	try {
		await runtime.runPromise(program)
	} catch (cause) {
		// The client sees this string. Keep it to the message — a raw `Cause` carries stack frames
		// and, inside a DatabaseError, connection details, and it is written to a durable log the
		// browser reads back.
		if (input.session.holdsTurn(input.messageId)) {
			input.session.append({
				type: "turn-end",
				messageId: input.messageId,
				reason: "error",
				error: cause instanceof Error ? cause.message : "The chat turn failed.",
			})
		}
	} finally {
		await runtime.dispose().catch(() => undefined)
		await telemetry.flush(input.env).catch(() => undefined)
	}
}
