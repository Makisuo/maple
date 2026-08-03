/**
 * Maple's seam onto `@maple/llm` — the vendored, Effect-native LLM core.
 *
 * Everything Maple-specific about talking to a model lives here, never inside `lib/llm`
 * (see `lib/llm/MAPLE.md`): the layer wiring, the Workers AI binding shim, model selection
 * from env, and the mapping from the vendored `LLMError` onto a Maple domain error.
 *
 * Layer shape mirrors `CloudflareApi.ts`: `LLMClient.layer <- RequestExecutor.layer <- HttpClient`.
 * `RequestExecutor` already owns retry, backoff and secret redaction, so the HTTP layer underneath
 * is plain `FetchHttpClient.layer` — optionally wrapped by the Workers AI shim.
 *
 * Deliberately NOT imported here: `@maple/llm/providers/amazon-bedrock`. It is the only path that
 * reaches `aws4fetch` and `@smithy/*`; leaving it unimported keeps both out of the Worker bundle.
 * Providers are deep-imported for the same reason — never the `providers/index.ts` barrel.
 */
import { LlmCallError } from "@maple/domain/llm"
import { CloudflareWorkersAI } from "@maple/llm/providers/cloudflare"
import { LLMClient, RequestExecutor } from "@maple/llm/route"
import { isContextOverflowFailure } from "@maple/llm"
import type { LLMClientService, LLMError, Model } from "@maple/llm"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layerWorkersAi } from "./WorkersAiHttpClient"

/**
 * Default triage/chat model. Carried over unchanged from the pre-`@maple/llm` chat backend
 * (`cloudflare/@cf/moonshotai/kimi-k2.6`, minus that runtime's `provider/` prefix), so the
 * backend swap did not silently change the model at the same time.
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6"

/**
 * Workers AI has no per-request API key when reached through the `AI` binding, but the vendored
 * provider still wants an account id for its base URL and a token for the `Authorization` header.
 * Both are inert once `layerWorkersAi` intercepts the request — the binding authenticates itself —
 * so a placeholder is correct rather than sloppy. If the binding is missing, the provider falls
 * through to the REST endpoint and these values matter, hence reading the real env first.
 */
const BINDING_PLACEHOLDER = "workers-ai-binding"

export interface LlmEnv extends Record<string, unknown> {
	readonly AI?: unknown
	readonly CLOUDFLARE_ACCOUNT_ID?: string
	readonly CLOUDFLARE_API_KEY?: string
	readonly MAPLE_TRIAGE_MODEL?: string
}

const readString = (env: LlmEnv, key: keyof LlmEnv): string | undefined => {
	const value = env[key]
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** Resolve the model the triage agent should run on, from env, with the Workers AI default. */
export const resolveTriageModel = (env: LlmEnv): Model =>
	CloudflareWorkersAI.configure({
		accountId: readString(env, "CLOUDFLARE_ACCOUNT_ID") ?? BINDING_PLACEHOLDER,
		apiKey: readString(env, "CLOUDFLARE_API_KEY") ?? BINDING_PLACEHOLDER,
	}).model(readString(env, "MAPLE_TRIAGE_MODEL") ?? DEFAULT_WORKERS_AI_MODEL)

/**
 * The runnable LLM stack. `env` supplies the `AI` binding; when it is absent the shim is a no-op
 * and requests go out over `fetch` to the Workers AI REST endpoint.
 */
export const layerLlm = (env: LlmEnv): Layer.Layer<LLMClientService> =>
	LLMClient.layer.pipe(
		Layer.provide(RequestExecutor.layer),
		Layer.provide(layerWorkersAi(env)),
		Layer.provide(FetchHttpClient.layer),
	)

/**
 * Map the vendored `LLMError` onto Maple's domain error, promoting context overflow to a
 * first-class, inspectable signal. Nothing in Maple had an equivalent before: a context-window
 * blow-up used to arrive as an opaque upstream failure, which is exactly the case a triage retry
 * should handle differently (shrink the transcript) from a transport blip (retry as-is).
 */
export const toLlmCallError = (operation: string, error: LLMError): LlmCallError => {
	// Provider output that fails to decode carries the offending frame on `reason.raw`. It is the
	// only thing that makes provider drift diagnosable — without it the failure is just "invalid
	// stream event" — but it is upstream text, so it goes to the log, never to the client error.
	const raw = (error.reason as { raw?: unknown }).raw
	if (typeof raw === "string" && raw !== "") {
		console.error(`[llm] ${operation}: ${error.message}; frame=${raw.slice(0, 500)}`)
	}
	return new LlmCallError({
		operation,
		module: error.module,
		method: error.method,
		reason: error.reason._tag,
		message: error.message,
		retryable: error.retryable,
		contextOverflow: isContextOverflowFailure(error),
	})
}
