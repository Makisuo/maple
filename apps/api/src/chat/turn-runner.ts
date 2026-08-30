/**
 * Running one chat turn, inside the `ChatSession` Durable Object.
 *
 * This module is the heavy half of the DO: the Effect runtime, the app service graph and
 * `@opencode-ai/ai`. `ChatSession.ts` reaches it through a dynamic import for the same reason
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
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "@/mcp/expected-failures"
import {
	decodeChatTurnTenant,
	type ChatMessage,
	type ChatTurnTenantEncoded,
} from "@maple/domain/chat-session"
import { layerFromEnvRecord, WorkerConfigProviderLayer } from "@maple/effect-cloudflare"
import { LLM, Message, type LanguageModel, type LLMClientService } from "@opencode-ai/ai"
import { Cause, Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { ChatSession } from "./ChatSession"
import type { TurnUsage } from "./loop"
import type { TenantContext } from "@/services/auth/tenant-context"
import { summarizeCause } from "@/platform/describe-cause"
import { trackTokenUsage } from "@/services/billing/autumn-tracker"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS, ...MCP_ANTICIPATED_ERROR_IDENTIFIERS],
})

export interface RunChatSessionTurnInput {
	/** The Durable Object itself. Appends are direct calls, not stub RPC. */
	readonly session: ChatSession
	readonly sessionId: string
	readonly env: Record<string, unknown>
	readonly messageId: string
	readonly tenant: ChatTurnTenantEncoded
}

/**
 * Decode the wire projection back into the `apps/api` tenant type.
 *
 * The Durable Object receives a plain, structured-cloneable object (RPC refuses class instances),
 * so the brands have to be re-established on this side before the value is used as a
 * `TenantContext`.
 */
const toTenantContext = (encoded: ChatTurnTenantEncoded): TenantContext => {
	const tenant = decodeChatTurnTenant(encoded)
	return {
		orgId: tenant.orgId,
		userId: tenant.userId,
		roles: [...tenant.roles],
		authMode: tenant.authMode,
		...(!(tenant.actorId === undefined) ? { actorId: tenant.actorId } : undefined),
	}
}

/**
 * How much transcript a turn replays.
 *
 * The log is append-only and never pruned, so without a bound a long-lived conversation grows
 * until it exceeds the model's context window — and then stays broken, because every retry sends
 * the same oversized request. Bounding by characters as well as by count matters because one
 * pasted stack trace can outweigh fifty short turns.
 */
const MAX_REPLAYED_MESSAGES = 40
const MAX_REPLAYED_CHARS = 60_000

/** How the summary is introduced to the model. */
const COMPACTION_PREAMBLE =
	"Summary of the earlier part of this conversation, which is no longer shown in full:\n\n"

/**
 * Project the durable transcript into `@opencode-ai/ai` messages, most recent first-limited.
 *
 * Tool calls are deliberately NOT replayed as tool messages: a rehydrated conversation needs the
 * *conclusions*, not a second copy of every tool payload, and replaying tool results without their
 * matching provider-native call ids is what makes providers reject a continuation. The assistant's
 * text is what carries forward. Sub-agent text is likewise excluded for free — it lives nested
 * inside a tool call, not at the top level.
 *
 * With a compaction, the head is replaced by its summary instead of being dropped. Without one, the
 * head-drop below is the fallback and stays exactly as it was: a compaction can fail or be evicted
 * before it is written, and a degraded turn is much better than a broken one.
 *
 * The summary rides as a **user** message. A synthetic assistant turn would assert the model said
 * something it did not, and several protocols dislike a conversation opening on an assistant turn.
 */
export const toLlmMessages = (
	history: ReadonlyArray<ChatMessage>,
	compaction?: { readonly summary: string; readonly throughSeq: number },
): ReadonlyArray<Message> => {
	if (compaction !== undefined) {
		const tail = toLlmMessages(history.filter((message) => message.startSeq > compaction.throughSeq))
		return [Message.user(COMPACTION_PREAMBLE + compaction.summary), ...tail]
	}

	const spoken = history.filter((message) => message.text.trim() !== "")

	// Walk backwards so the newest turns are the ones kept: the tail is the part the next turn
	// actually needs, and dropping from the head is what a human skimming a long thread does too.
	const kept: Array<ChatMessage> = []
	let chars = 0
	for (let i = spoken.length - 1; i >= 0; i--) {
		const message = spoken[i]!
		if (kept.length >= MAX_REPLAYED_MESSAGES) break
		if (chars + message.text.length > MAX_REPLAYED_CHARS && kept.length > 0) break
		chars += message.text.length
		kept.push(message)
	}
	kept.reverse()

	return kept.map((message) =>
		message.role === "user" ? Message.user(message.text) : Message.assistant(message.text),
	)
}

/**
 * Summarize the conversation so far, if the last turn came close to the context wall.
 *
 * **After the answer, not during it.** opencode compacts mid-turn and re-enters its loop, which it
 * can afford: one flat transcript, no client-side message identity, a process that lives as long as
 * the terminal. Here that would interleave a second model call into a stream the browser is
 * rendering keyed by `messageId`, add seconds to the visible answer, and need a second `turn-start`
 * the client would have to learn. Doing it after costs the user nothing — the answer is already
 * delivered — and the worst case if the isolate is evicted first is that the next turn falls back to
 * the head-drop. A degradation, not a corruption.
 *
 * Runs inside the turn's own program, *before* the runtime is disposed and before `endTurn` releases
 * the slot: a separate `waitUntil` after the slot was freed could let a new turn start against a
 * half-written compaction.
 */
const compactIfNeeded = (
	input: RunChatSessionTurnInput,
	model: LanguageModel,
	usage: TurnUsage,
): Effect.Effect<void, never, LLMClientService> =>
	Effect.gen(function* () {
		const { contextLimitOf, outputLimitOf } = yield* Effect.promise(() => import("../platform/Llm"))
		const {
			addUsage,
			isNearContextLimit,
			annotateModelResponse,
			modelCallAttributes,
			modelCallSpanName,
		} = yield* Effect.promise(() => import("./loop"))
		if (
			!isNearContextLimit(usage.input, {
				context: contextLimitOf(model),
				output: outputLimitOf(model),
			})
		) {
			return
		}
		// An aborted turn must not append a compaction: the conversation it would summarize is not
		// the one the user is looking at.
		if (!input.session.holdsTurn(input.messageId)) return

		const { COMPACTION_SYSTEM_PROMPT } = yield* Effect.promise(() => import("./prompts"))
		const history = input.session.history()
		const throughSeq = input.session.cursor()
		const previous = input.session.compaction()

		// A model call like any other to the gen-ai session, even though it is
		// housekeeping: it costs real tokens, and a session view that hides it
		// under-reports what the conversation spent.
		const request = LLM.request({
			model,
			system: COMPACTION_SYSTEM_PROMPT,
			messages: [...toLlmMessages(history, previous)],
			prompt: "Compact the conversation above now.",
		})
		const response = yield* LLM.generate(request).pipe(
			Effect.tap((generated) => annotateModelResponse(generated)),
			Effect.withSpan(modelCallSpanName(model), {
				kind: "client",
				// The whole request, so the span records what the model was actually
				// sent — including the prompt `LLM.request` appends as the trailing
				// user message, and the system half.
				attributes: {
					...modelCallAttributes(
						request,
						{ sessionId: input.sessionId, turnId: input.messageId },
						{ stream: false },
					),
					"gen_ai.conversation.compacted": true,
				},
			}),
		)
		// Housekeeping the org still pays for, so it is added to the turn's total and
		// billed with it. Safe to mutate here: the near-limit check above has read
		// `usage.input` already, and `submit_diagnosis` — the only mid-turn reader —
		// ran long before the answer this is compacting behind.
		addUsage(usage, response.usage)
		const summary = response.text.trim()
		if (summary === "") return
		input.session.append({ type: "compaction", messageId: input.messageId, summary, throughSeq })
	}).pipe(
		// Bounded, and never allowed to turn a delivered answer into a failed turn. A conversation
		// that stays uncompacted just falls back to the head-drop next time.
		Effect.timeout(COMPACTION_TIMEOUT),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: Effect.annotateCurrentSpan("maple.chat.compaction_outcome", "failed").pipe(
						Effect.andThen(
							Effect.logWarning("Chat transcript compaction failed").pipe(
								Effect.annotateLogs({
									sessionId: input.sessionId,
									messageId: input.messageId,
									cause: summarizeCause(cause),
								}),
							),
						),
					),
		),
	)

/** Compaction is housekeeping; it must not hold the turn slot open. */
const COMPACTION_TIMEOUT = "20 seconds"

/** Stable copy for the durable/browser event; detailed causes stay server-side. */
const CHAT_TURN_FAILED = "Maple couldn't complete this response."

/**
 * Meter what this turn spent into the org's AI usage, alongside autonomous triage
 * and the Slack agent.
 *
 * `usage` is the turn's whole total: every step, every sub-agent (they share the
 * parent's accumulator), and the compaction that runs after the answer.
 *
 * Two deliberate choices:
 *
 *   - **In the `finally`, not on the happy path.** A turn that failed or was aborted
 *     mid-stream still spent whatever the provider had already served. Metering
 *     follows the spend, not the outcome.
 *   - **Keyed on the message id**, which identifies the turn: the session claims one
 *     per turn and never reuses it, so a turn that somehow ran twice still meters
 *     once.
 *
 * Exported for tests; the only production caller is the `finally` below.
 */
export const meterTurn = async (
	input: {
		readonly env: Record<string, unknown>
		readonly sessionId: string
		readonly messageId: string
	},
	orgId: TenantContext["orgId"],
	usage: TurnUsage,
): Promise<void> => {
	// `submit_diagnosis` already billed this turn under `triage`; see `TurnUsage.metered`.
	if (usage.metered) return
	await trackTokenUsage(input.env, {
		orgId,
		inputTokens: usage.input,
		outputTokens: usage.output,
		idempotencyKey: `${input.sessionId}:${input.messageId}`,
		source: "chat",
	})
}

/**
 * Drive one turn to completion.
 *
 * Resolves as a promise because the caller is a Durable Object method, not an Effect. Failures are
 * recorded into the log as a terminal event rather than propagated: the log is the only thing the
 * client reads, so a turn that dies without one is indistinguishable from a turn that hung.
 */
export const runChatSessionTurn = async (input: RunChatSessionTurnInput): Promise<void> => {
	const [
		{ InvestigationServicesLive },
		{ layerPg },
		{ layerLlm, resolveTriageModel },
		loop,
		{ buildDiagnosisCompletion },
		{ McpToolExecutor },
	] = await Promise.all([
		import("../runtime/mcp-service-graph"),
		import("../platform/DatabasePgLive"),
		import("../platform/Llm"),
		import("./loop"),
		import("./tools"),
		import("../mcp/dispatcher"),
	])
	const { InvestigationService } = await import("@/services/errors/InvestigationService")

	const runtime = ManagedRuntime.make(
		InvestigationServicesLive.pipe(
			Layer.provideMerge(layerLlm(input.env)),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(layerFromEnvRecord(input.env)),
			Layer.provideMerge(telemetry.layer),
			Layer.provideMerge(WorkerConfigProviderLayer),
		),
	)

	const tenant = toTenantContext(input.tenant)
	const observability = loop.makeTurnObservability()
	// Out here so the `finally` can bill a turn that failed or was aborted mid-stream.
	// Shared with the turn so `submit_diagnosis` can report what the investigation cost —
	// see `TurnUsage`: the tool is invoked mid-turn, so there is no later moment to hand
	// it a total.
	const usage = loop.makeTurnUsage()
	let recordedTerminal = false
	const annotateTurn = () =>
		Effect.annotateCurrentSpan({
			"maple.chat.outcome": observability.outcome ?? "unknown",
			...(!(observability.finishReason === undefined)
				? {
						"maple.chat.finish_reason": observability.finishReason,
					}
				: undefined),
			"maple.chat.empty_output": observability.emptyOutput,
			"maple.chat.recovery_count": observability.recoveryCount,
			...(!(observability.failureReason === undefined)
				? {
						"maple.chat.failure_reason": observability.failureReason,
					}
				: undefined),
		})

	const program = Effect.gen(function* () {
		const investigations = yield* InvestigationService
		const toolExecutor = yield* McpToolExecutor
		const history = input.session.history()
		const model = resolveTriageModel(input.env, {
			surface: "chat",
			orgId: tenant.orgId,
			sessionId: input.sessionId,
		})
		// One value: the tool *and* whether this turn's answer is a call to it. Passing the tool alone
		// is what left an autonomous investigation with no way to file its report once it ran out of
		// steps — see `buildDiagnosisCompletion`.
		const completion = buildDiagnosisCompletion(
			input.sessionId,
			tenant,
			investigations.submitDiagnosis,
			usage,
			model,
		)

		yield* loop
			.runChatTurn({
				sessionId: input.sessionId,
				tenant,
				toolExecutor,
				model,
				messages: toLlmMessages(history, input.session.compaction()),
				messageId: input.messageId,
				...(completion === undefined ? undefined : { completion }),
				usage,
				observability,
				// An abort clears the claim; the turn notices here and stops at the next event
				// rather than streaming into a conversation that has moved on.
				isCurrent: () => input.session.holdsTurn(input.messageId),
				// Sub-agent events reach the log through here rather than through the returned
				// stream — see the note on `ChatTurnInput.emit`. The `holdsTurn` guard mirrors the
				// `Stream.takeWhile` below, so an aborted turn's in-flight sub-agent stops writing
				// too rather than appending into a conversation that has moved on.
				emit: (event) => {
					if (input.session.holdsTurn(input.messageId)) input.session.append(event)
				},
			})
			.pipe(
				Stream.takeWhile(() => input.session.holdsTurn(input.messageId)),
				Stream.runForEach((event) =>
					Effect.sync(() => {
						input.session.append(event)
						if (event.type === "turn-end" && event.task === undefined) {
							recordedTerminal = true
							observability.outcome = event.reason
						}
					}),
				),
			)

		if (!recordedTerminal && !input.session.holdsTurn(input.messageId)) {
			observability.outcome = "aborted"
		}
		yield* annotateTurn()
		yield* compactIfNeeded(input, model, usage)
	}).pipe(
		Effect.tapCause((cause) => {
			observability.outcome = "error"
			observability.failureReason ??= "UnhandledTurnFailure"
			return annotateTurn().pipe(
				Effect.andThen(
					Effect.logError("Unhandled chat turn failure").pipe(
						Effect.annotateLogs({
							sessionId: input.sessionId,
							messageId: input.messageId,
							cause: summarizeCause(cause),
						}),
					),
				),
			)
		}),
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
	} catch {
		// The detailed cause belongs in server logs and the failed Effect span, never in the durable
		// event the browser reads back.
		if (input.session.holdsTurn(input.messageId)) {
			input.session.append({
				type: "turn-end",
				messageId: input.messageId,
				reason: "error",
				error: CHAT_TURN_FAILED,
			})
		}
	} finally {
		await meterTurn(input, tenant.orgId, usage).catch(() => undefined)
		await runtime.dispose().catch(() => undefined)
		await telemetry.flush(input.env).catch(() => undefined)
	}
}
