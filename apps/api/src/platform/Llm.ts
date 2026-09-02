/**
 * Maple's seam onto `@opencode-ai/ai` — opencode's Effect-native LLM core.
 *
 * Everything Maple-specific about talking to a model lives here, never in a wrapper around the
 * package: the layer wiring, the Workers AI binding shim, provider/model selection from env, and
 * the mapping from the upstream `AIError` onto a Maple domain error.
 *
 * Two provider paths stay live at once — OpenRouter (default) and Cloudflare Workers AI — and
 * `MAPLE_LLM_PROVIDER` picks between them per deploy without a code change.
 *
 * Layer shape mirrors `CloudflareApi.ts`: `LLMClient.layer <- RequestExecutor.layer <- HttpClient`.
 * `RequestExecutor` already owns retry, backoff and secret redaction, so the HTTP layer underneath
 * is plain `FetchHttpClient.layer` — optionally wrapped by the Workers AI shim.
 *
 * Deliberately NOT imported here: `@opencode-ai/ai/providers/amazon-bedrock`. It is the only path
 * that reaches `aws4fetch` and `@smithy/*`; leaving it unimported keeps both out of the Worker
 * bundle. `providers/google-vertex` is out for the same reason — it pulls `google-auth-library`.
 * Providers are deep-imported for the same reason — never the `providers/index.ts` barrel.
 */
import { LlmCallError } from "@maple/domain/llm"
import { CloudflareWorkersAI } from "@opencode-ai/ai/providers/cloudflare"
import * as OpenRouter from "@opencode-ai/ai/providers/openrouter"
import { LLMClient, RequestExecutor } from "@opencode-ai/ai/route"
import { isContextOverflowFailure, LanguageModel } from "@opencode-ai/ai"
import type { AIError, LLMClientService } from "@opencode-ai/ai"
import { Layer, Predicate } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layerWorkersAi } from "./WorkersAiHttpClient"

/**
 * Default triage/chat model on OpenRouter — the provider agents run on by default.
 */
export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash:nitro"

/**
 * OpenRouter app attribution. `HTTP-Referer` is the header that actually creates the app page —
 * a title on its own does nothing — so both are sent together or not at all. One URL for every
 * surface on purpose: a second referer would mint a second app entry and split the rankings.
 */
const OPENROUTER_APP_URL = "https://maple.dev"
const OPENROUTER_APP_TITLE = "Maple"

/**
 * Where a model call came from and what it is running for.
 *
 * OpenRouter surfaces these three in different places, which is why all three are worth sending:
 * `user` shows up on the activity page and in usage exports, `session_id` groups a conversation
 * (and makes OpenRouter route the whole session to one provider, so prompt caches actually hit),
 * and `trace` is forwarded to any configured Broadcast destination.
 */
export interface LlmCallTags {
	readonly surface: "chat" | "ai-triage" | "investigation-lens" | "investigation-validator"
	readonly orgId: string
	/** Groups one conversation or investigation. OpenRouter caps this at 256 characters. */
	readonly sessionId?: string
}

/**
 * The tag fields as OpenRouter's request body wants them. Kept next to the `configure` call that
 * uses it because these are OpenRouter's field names, not Maple's — the Workers AI branch must
 * never see them.
 */
const openRouterTagBody = (tags: LlmCallTags) => ({
	user: tags.orgId,
	...(!(tags.sessionId === undefined) ? { session_id: tags.sessionId.slice(0, 256) } : undefined),
	trace: { trace_name: tags.surface },
})

/**
 * Default triage/chat model on Workers AI. Carried over unchanged from the chat backend that
 * preceded this one (`cloudflare/@cf/moonshotai/kimi-k2.6`, minus that runtime's `provider/`
 * prefix), so the backend swap did not silently change the model at the same time.
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6"

/**
 * The two provider paths agents can run on. Both stay wired at all times — flipping between them
 * is one env var (`MAPLE_LLM_PROVIDER`) and no redeploy of code, because `layerLlm` builds the
 * same stack either way (see below).
 */
export type LlmProvider = "openrouter" | "workers-ai"

export const DEFAULT_LLM_PROVIDER: LlmProvider = "openrouter"

/**
 * Workers AI has no per-request API key when reached through the `AI` binding, but the upstream
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
	readonly MAPLE_LLM_PROVIDER?: string
	readonly MAPLE_TRIAGE_MODEL_OPENROUTER?: string
	readonly MAPLE_TRIAGE_MODEL_WORKERS_AI?: string
	/** Context window in tokens, overriding {@link MODEL_LIMITS} for the configured model. */
	readonly MAPLE_TRIAGE_MODEL_CONTEXT?: string
	/** Max completion tokens, overriding {@link MODEL_LIMITS} for the configured model. */
	readonly MAPLE_TRIAGE_MODEL_OUTPUT?: string
	/** Cheaper model for the fan-out lens passes; falls back to the triage model. */
	readonly MAPLE_LENS_MODEL_OPENROUTER?: string
	readonly MAPLE_LENS_MODEL_WORKERS_AI?: string
	/** `low` | `medium` | `high` | `off`. See {@link ReasoningEffort}. */
	readonly MAPLE_TRIAGE_REASONING_EFFORT?: string
	readonly MAPLE_LENS_REASONING_EFFORT?: string
	readonly OPENROUTER_API_KEY?: string
}

/**
 * How hard the model should think before answering.
 *
 * The other dial. Maple has always tiered spend by swapping model *ids* — `resolveLensModel` picks a
 * cheaper model than `resolveTriageModel` — but on a gpt-5.6-family model the reasoning budget moves
 * cost and latency at least as much, and it does so without changing which model's judgement you are
 * getting. Two different framings of "spend less on this stage", and they compose.
 *
 * `off` omits the field entirely rather than sending a zero budget: a model that does not support
 * reasoning must see no `reasoning` key at all, so this is also the escape hatch if a swapped-in
 * model rejects it.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "off"

const REASONING_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "off"])

const readReasoningEffort = (env: LlmEnv, key: keyof LlmEnv): ReasoningEffort | undefined => {
	const raw = readString(env, key)?.toLowerCase()
	// An unrecognized value falls through to the caller's default rather than throwing. This is read
	// on a request path in a Worker; a typo'd env var must not take the agent down.
	return raw !== undefined && REASONING_EFFORTS.has(raw) ? (raw as ReasoningEffort) : undefined
}

/**
 * Bind the reasoning budget onto a model's defaults.
 *
 * `providerOptions` on `LanguageModel.defaults` is merged into every request by the route client's
 * `resolveRequestOptions`, under the *request's* own options — so this is a default a call site can
 * still override, which is what makes it the right place for a per-stage policy.
 *
 * OpenRouter-only. `providerOptions` is already provider-scoped — one request goes to one provider,
 * and that provider's adapter lowers the whole record into the body — so this must only ever be set
 * on a model the OpenRouter branch resolved.
 */
const withReasoning = (model: LanguageModel, effort: ReasoningEffort | undefined): LanguageModel =>
	effort === undefined || effort === "off"
		? model
		: LanguageModel.update(model, {
				defaults: {
					...model.defaults,
					providerOptions: { ...model.defaults?.providerOptions, reasoning: { effort } },
				},
			})

/**
 * OpenRouter usage accounting: `usage: {include: true}` makes the final usage
 * object of every response carry `cost` — the credits (USD) OpenRouter actually
 * charged for the call. The gen-ai spans emit it as `gen_ai.usage.cost`
 * (`modelResponseAttributes` in `chat/loop/genai.ts`), which is the only way
 * Maple ever reports spend: the provider's own bill, never a price table.
 * OpenRouter-only — Workers AI has no per-call price to report.
 */
const withUsageAccounting = (model: LanguageModel): LanguageModel =>
	LanguageModel.update(model, {
		defaults: {
			...model.defaults,
			providerOptions: { ...model.defaults?.providerOptions, usage: true },
		},
	})

/**
 * Context windows for the models Maple configures.
 *
 * `@opencode-ai/ai` models carry no context window — the field it once declared was never populated
 * by any provider and is gone. Maple needs it to know when a transcript is approaching the wall, so
 * it is kept here, at the Maple seam, in a side table keyed by the resolved model.
 *
 * Conservative on purpose. A limit set too low compacts early, which costs a summarization call; a
 * limit set too high overflows, which costs the whole turn. When in doubt, go low.
 */
const MODEL_LIMITS: Record<string, { readonly context: number; readonly output: number }> = {
	// Verified against OpenRouter's public model catalogue.
	"openai/gpt-5.6-luna": { context: 1_050_000, output: 128_000 },
	// Context set from the operator-supplied figure, not the catalogue. Output is not stated with
	// it, so it stays at the conservative default; raise it with `MAPLE_TRIAGE_MODEL_OUTPUT` if
	// completions are being cut short.
	"z-ai/glm-5.3-flash:nitro": { context: 130_000, output: 8_000 },
	// Moonshot's own `kimi-k2.6` is 262_144, but Cloudflare does not publish the window its Workers
	// AI deployment actually serves, and a serving deployment is usually narrower than upstream's
	// maximum. Held at the conservative default until someone measures it; override with
	// `MAPLE_TRIAGE_MODEL_CONTEXT` if the real figure turns out to be higher.
	"@cf/moonshotai/kimi-k2.6": { context: 128_000, output: 8_000 },
} satisfies Record<string, { readonly context: number; readonly output: number }>

/** For a model not in the table at all. Low enough that an unknown model compacts rather than fails. */
const DEFAULT_MODEL_LIMITS = { context: 128_000, output: 8_000 } as const

const readPositiveInt = (env: LlmEnv, key: keyof LlmEnv): number | undefined => {
	const raw = readString(env, key)
	if (raw === undefined) return undefined
	const value = Number(raw)
	return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Limits for the models this module resolves, keyed by the model instance `withLimits` returned.
 *
 * A side table rather than a field on the model: `providerOptions` is the only extension point
 * upstream leaves open, and everything in it is sent to the provider.
 */
const MODEL_LIMIT_TABLE = new WeakMap<LanguageModel, { readonly context: number; readonly output: number }>()

/**
 * The context budget a turn should plan against, in tokens, or `undefined` if the model declares
 * none. Callers treat `undefined` as "don't compact" rather than guessing a number.
 */
export const contextLimitOf = (model: LanguageModel): number | undefined =>
	MODEL_LIMIT_TABLE.get(model)?.context

/** Max completion tokens, used to reserve headroom when deciding whether the input still fits. */
export const outputLimitOf = (model: LanguageModel): number | undefined =>
	MODEL_LIMIT_TABLE.get(model)?.output

const readString = (env: LlmEnv, key: keyof LlmEnv): string | undefined => {
	const value = env[key]
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * Which provider agents run on. LanguageModel overrides are deliberately provider-scoped: a model id is
 * only meaningful to one provider, so a single shared `MAPLE_TRIAGE_MODEL` would send `@cf/…` to
 * OpenRouter the moment someone flipped the switch. With one var per provider, both can stay set
 * and the flip is genuinely one variable.
 */
export const resolveLlmProvider = (env: LlmEnv): LlmProvider =>
	readString(env, "MAPLE_LLM_PROVIDER")?.toLowerCase() === "workers-ai"
		? "workers-ai"
		: DEFAULT_LLM_PROVIDER

/**
 * Resolve the model the triage/chat agents should run on, from env.
 *
 * `tags` is optional and OpenRouter-only. Attribution headers ride on every OpenRouter call
 * regardless; the per-call tags are folded into the request body as route defaults, so every
 * `LLM.request`/`generate`/`stream` made with the returned model carries them without each call
 * site having to thread them through. The Workers AI branch deliberately ignores `tags` — they are
 * OpenRouter's body fields and have no meaning to Cloudflare.
 */
export const resolveTriageModel = (env: LlmEnv, tags?: LlmCallTags): LanguageModel =>
	withLimits(
		env,
		resolveLlmProvider(env) === "workers-ai"
			? CloudflareWorkersAI.configure({
					accountId: readString(env, "CLOUDFLARE_ACCOUNT_ID") ?? BINDING_PLACEHOLDER,
					apiKey: readString(env, "CLOUDFLARE_API_KEY") ?? BINDING_PLACEHOLDER,
				}).model(readString(env, "MAPLE_TRIAGE_MODEL_WORKERS_AI") ?? DEFAULT_WORKERS_AI_MODEL)
			: withUsageAccounting(
					withReasoning(
						OpenRouter.configure({
							apiKey: readString(env, "OPENROUTER_API_KEY") ?? "",
							headers: { "HTTP-Referer": OPENROUTER_APP_URL, "X-Title": OPENROUTER_APP_TITLE },
							...(!(tags === undefined)
								? { http: { body: openRouterTagBody(tags) } }
								: undefined),
						}).model(
							readString(env, "MAPLE_TRIAGE_MODEL_OPENROUTER") ?? DEFAULT_OPENROUTER_MODEL,
						),
						// No default. This resolver serves chat, AI triage *and* the validator, so a
						// number picked here would silently retune three stages with different shapes at
						// once — worth doing per stage, with measurement, not as a side effect of adding
						// the knob.
						readReasoningEffort(env, "MAPLE_TRIAGE_REASONING_EFFORT"),
					),
				),
	)

/**
 * Record the model's context window, which upstream leaves unstated.
 *
 * Every resolver ends here, so the instance a caller holds is the one the table is keyed by — a
 * model that never passed through reports `undefined`, which callers read as "don't compact".
 */
const withLimits = (env: LlmEnv, model: LanguageModel): LanguageModel => {
	const known = MODEL_LIMITS[String(model.id)] ?? DEFAULT_MODEL_LIMITS
	MODEL_LIMIT_TABLE.set(model, {
		context: readPositiveInt(env, "MAPLE_TRIAGE_MODEL_CONTEXT") ?? known.context,
		output: readPositiveInt(env, "MAPLE_TRIAGE_MODEL_OUTPUT") ?? known.output,
	})
	return model
}

/**
 * The model a fan-out *lens* runs on.
 *
 * Lenses gather evidence through one narrow framing; the validator does the
 * actual reasoning about which candidate explains the incident. So the spend
 * belongs on the validator, and a fan-out of five otherwise multiplies the
 * expensive model by five for work that a cheaper one does adequately.
 *
 * Falls back to the triage model when unset, so tiering is opt-in per stage and
 * an unconfigured environment behaves exactly as it does today. The validator
 * has no resolver of its own on purpose — it *is* `resolveTriageModel`, and
 * introducing a third knob would let the ranking silently drift below the
 * lenses it ranks.
 *
 * The reasoning budget is that same argument in its other form, and it is the one
 * part of this that is **not** opt-in: `low` by default, because "gather evidence
 * through one narrow framing" describes a task that does not need a long think,
 * and the fan-out multiplies whatever it does need by five. Raise it with
 * `MAPLE_LENS_REASONING_EFFORT`, or set that to `off` to send no reasoning field.
 *
 * `withLimits` is not optional here, though it looked it: without it
 * `defaults.limits` is `undefined`, so `contextLimitOf` returns `undefined`, so
 * the turn loop's `isNearContextLimit` check never fires and a lens pass never
 * sheds a step — the one agent class that fills its window with raw
 * telemetry was the only one running without the guard. Note the coupling this
 * introduces: `MAPLE_TRIAGE_MODEL_CONTEXT`/`_OUTPUT` are read inside
 * `withLimits`, so a lens on a *different* model inherits the triage overrides.
 * Acceptable — an override is set to describe a deployment, not a single model —
 * but it is the thing to fix first if the two stages ever diverge that far.
 */
export const resolveLensModel = (env: LlmEnv, tags?: LlmCallTags): LanguageModel =>
	withLimits(
		env,
		resolveLlmProvider(env) === "workers-ai"
			? CloudflareWorkersAI.configure({
					accountId: readString(env, "CLOUDFLARE_ACCOUNT_ID") ?? BINDING_PLACEHOLDER,
					apiKey: readString(env, "CLOUDFLARE_API_KEY") ?? BINDING_PLACEHOLDER,
				}).model(
					readString(env, "MAPLE_LENS_MODEL_WORKERS_AI") ??
						readString(env, "MAPLE_TRIAGE_MODEL_WORKERS_AI") ??
						DEFAULT_WORKERS_AI_MODEL,
				)
			: withUsageAccounting(
					withReasoning(
						OpenRouter.configure({
							apiKey: readString(env, "OPENROUTER_API_KEY") ?? "",
							headers: { "HTTP-Referer": OPENROUTER_APP_URL, "X-Title": OPENROUTER_APP_TITLE },
							...(!(tags === undefined)
								? { http: { body: openRouterTagBody(tags) } }
								: undefined),
						}).model(
							readString(env, "MAPLE_LENS_MODEL_OPENROUTER") ??
								readString(env, "MAPLE_TRIAGE_MODEL_OPENROUTER") ??
								DEFAULT_OPENROUTER_MODEL,
						),
						readReasoningEffort(env, "MAPLE_LENS_REASONING_EFFORT") ?? "low",
					),
				),
	)

/**
 * The runnable LLM stack — identical for both providers, which is what makes the switch a pure
 * env flip. The Workers AI shim stays in the stack unconditionally: it only intercepts POSTs to
 * the Workers AI chat URL, so it is inert for OpenRouter traffic. `env` supplies the `AI` binding;
 * when it is absent the shim is a no-op and Workers AI requests go out over `fetch` to the REST
 * endpoint instead.
 */
export const layerLlm = (env: LlmEnv): Layer.Layer<LLMClientService> =>
	LLMClient.layer.pipe(
		Layer.provide(RequestExecutor.layer),
		Layer.provide(layerWorkersAi(env)),
		Layer.provide(FetchHttpClient.layer),
	)

/**
 * Map the upstream `AIError` onto Maple's domain error, promoting context overflow to a
 * first-class, inspectable signal. Nothing in Maple had an equivalent before: a context-window
 * blow-up used to arrive as an opaque upstream failure, which is exactly the case a triage retry
 * should handle differently (shrink the transcript) from a transport blip (retry as-is).
 */
export const toLlmCallError = (operation: string, error: AIError): LlmCallError => {
	// Provider output that fails to decode carries the offending frame on `reason.raw`. It is the
	// only thing that makes provider drift diagnosable — without it the failure is just "invalid
	// stream event" — but it is upstream text, so it goes to the log, never to the client error.
	const raw = Predicate.hasProperty(error.reason, "raw") ? error.reason.raw : undefined
	if (typeof raw === "string" && raw !== "") {
		console.error(`[llm] ${operation}: ${error.message}; frame=${raw.slice(0, 500)}`)
	}
	return new LlmCallError({
		operation,
		module: error.module,
		method: error.method,
		reason: error.reason._tag,
		message: error.message,
		retryable: RETRYABLE_REASONS.has(error.reason._tag),
		contextOverflow: isContextOverflowFailure(error),
	})
}

/**
 * Failures worth sending again unchanged: a rate limit clears, and `ProviderInternal` is the 5xx
 * bucket. Upstream used to carry this as a flag on the error and no longer does, so the judgement
 * lives here — `chat/loop/retry.ts` widens it for the mid-stream failures neither side retries.
 */
const RETRYABLE_REASONS: ReadonlySet<string> = new Set(["RateLimit", "ProviderInternal"])
