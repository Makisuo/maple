import { Context, Duration, Effect, Layer, Option, Redacted, Result } from "effect"
import { HttpClient } from "effect/unstable/http"
import { SyncConfig } from "../config"
import { ElectricNotConfigured, ElectricUpstreamError, ElectricUpstreamUnreachable } from "../errors"
import { lookupSubscription } from "../shapes/registry"
import type { ScopeBinding, SyncRequest } from "../shapes/request"

// The client controls only Electric's cursor and cache-buster parameters; table,
// projection, predicates, and bindings remain server-pinned. Cache busters must
// reach the upstream URL or a CDN can replay an expired handle in a 409 loop.
const CLIENT_PASSTHROUGH_PARAMS = [
	"offset",
	"handle",
	"live",
	"cursor",
	"expired_handle",
	"cache-buster",
] as const

/**
 * Ceiling for a NON-live shape request. A snapshot or historical log chunk is a
 * plain request/response and should never take this long; without a bound, a
 * wedged upstream holds the isolate until Cloudflare kills it, with no span to
 * show for it.
 *
 * It deliberately does not apply to `live` requests: those long-poll (Electric
 * holds the connection ~20s waiting for a change and then returns a complete
 * response), so a global timeout would sever every healthy live poll and put the
 * client into a permanent reconnect loop.
 */
const UPSTREAM_TIMEOUT = Duration.seconds(30)

/**
 * Strips the Electric Cloud source secret out of anything headed for telemetry.
 *
 * The upstream URL carries `secret=…`, and error text routinely embeds that URL,
 * so any failure string that reaches a span or a log has to come through here
 * first. Applied to the FULLY composed string — see `describeUpstreamFailure`.
 */
const redactSecrets = (text: string): string => text.replace(/(secret=)[^&\s)]*/g, "$1REDACTED")

/**
 * Renders an upstream failure for a span message and a log.
 *
 * It keeps the *cause*: an `HttpClientError`'s own text is "Transport error
 * (GET …)", and the part worth reading (ECONNREFUSED, the DNS failure, the
 * abort) is one level down.
 *
 * Exported so the redaction is asserted directly rather than inferred from an
 * upstream failure that may or may not carry a URL in its cause.
 */
export const describeUpstreamFailure = (error: unknown): string => {
	// `Cause.TimeoutError` carries no `message`, so fall back through name to the
	// string form rather than interpolating `undefined` into a span.
	const text = error instanceof Error ? error.message || error.name || String(error) : String(error)
	const cause = error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined
	// Redact AFTER composing, never per-part: a fetch failure's cause commonly
	// embeds the request URL too, so redacting only the outer text would leak the
	// exact credential this exists to protect.
	return redactSecrets(cause === undefined ? text : `${text}: ${cause}`)
}

const isLiveRequest = (clientParams: URLSearchParams): boolean => {
	const live = clientParams.get("live")
	return live !== null && live !== "false"
}

/**
 * Builds the upstream Electric `/v1/shape` URL. Pure and exported so tests can
 * assert that a client can never override the pinned `table`/`where`/`params` —
 * only the whitelisted cursor params flow through.
 */
export const buildUpstreamSyncUrl = (args: {
	readonly electricUrl: string
	readonly request: SyncRequest
	readonly orgId: string
	readonly sourceId?: string | undefined
	readonly secret?: string | undefined
}): string => {
	const def = lookupSubscription(args.request.shape)

	// Every bound predicate, in positional order. The org scope always leads; a
	// scoped shape adds its own, already paired with its column by the decoder.
	// Both `$n` and `params[n]` are derived from THIS ONE list, so the predicate
	// and its binding cannot drift apart and no index is ever written by hand —
	// adding a third bound column later is one entry here, not four edits that
	// have to agree.
	const bindings: ReadonlyArray<ScopeBinding> = [
		{ column: "org_id", value: args.orgId },
		...(args.request.scope === null ? [] : [args.request.scope]),
	]
	const positional = (index: number) => index + 1

	// The complete upstream query, pinned server-side. Building it as one value
	// makes the pinned surface readable in a glance — anything not named here is
	// something a client cannot influence.
	const pinned: Record<string, string> = {
		table: def.table,
		where: [
			// Column names come from our own whitelist and values go in positionally,
			// so neither half of any predicate is ever client-authored SQL.
			...bindings.map(({ column }, index) => `"${column}" = $${positional(index)}`),
			// A shape's own `extraWhere` may only narrow further, never replace.
			...(def.extraWhere ? [def.extraWhere] : []),
		].join(" AND "),
		...Object.fromEntries(bindings.map(({ value }, index) => [`params[${positional(index)}]`, value])),
		// The projection is pinned too — a shape that drops secret / oversized
		// columns must never let the client widen it back to `SELECT *`.
		...(def.columns ? { columns: def.columns.join(",") } : undefined),
		// Electric Cloud source credentials (absent when self-hosting Electric).
		...(args.sourceId ? { source_id: args.sourceId } : undefined),
		...(args.secret ? { secret: args.secret } : undefined),
	} satisfies Record<string, string>

	const url = new URL(`${args.electricUrl.replace(/\/+$/, "")}/v1/shape`)
	for (const [key, value] of Object.entries(pinned)) url.searchParams.set(key, value)

	// Client params go on last but can never overwrite a pinned key — the
	// passthrough list and the pinned keys are disjoint by construction.
	for (const key of CLIENT_PASSTHROUGH_PARAMS) {
		const value = args.request.clientParams.get(key)
		if (value !== null) url.searchParams.set(key, value)
	}

	return url.toString()
}

/**
 * Electric Cloud authenticates every shape request with a source `secret`
 * (paired with `source_id`); self-hosted Electric (local docker) needs neither.
 * A config carrying exactly ONE of the two is incoherent — most commonly a
 * deploy that inherited a shared `ELECTRIC_URL` + `ELECTRIC_SOURCE_ID` from the
 * secret store but no matching `ELECTRIC_SECRET` (e.g. a PR preview whose per-PR
 * Electric source step was skipped because the CLI token isn't provisioned).
 * Forwarding that upstream is a guaranteed 401 `MISSING_SECRET` from Electric
 * Cloud, which surfaces as a hard-broken shape stream in the browser. Instead we
 * treat it as "not configured" and take the same 503 graceful-degrade path as a
 * missing `ELECTRIC_URL`. Pure + exported so the coherence rule is unit-tested.
 */
export const isElectricConfigCoherent = (creds: {
	readonly sourceId: Option.Option<unknown>
	readonly secret: Option.Option<unknown>
}): boolean => Option.isSome(creds.sourceId) === Option.isSome(creds.secret)

export interface ElectricUpstreamResponse {
	readonly status: number
	readonly headers: Record<string, string>
	readonly body: string
}

export interface ElectricClientApi {
	/**
	 * Whether this deploy can serve shapes at all. Separate from `fetchShape` so
	 * the route can take the graceful-degrade path *before* authenticating — an
	 * unconfigured deploy answers 503 to everyone, which is what the web app's
	 * collections watch for to fall back to their effect-atom fetches.
	 */
	readonly ensureConfigured: Effect.Effect<void, ElectricNotConfigured>
	readonly fetchShape: (
		request: SyncRequest,
		orgId: string,
	) => Effect.Effect<
		ElectricUpstreamResponse,
		ElectricNotConfigured | ElectricUpstreamUnreachable | ElectricUpstreamError
	>
}

/**
 * The Electric upstream, as a service.
 *
 * Everything that talks to Electric lives behind this interface: the pinned URL,
 * the Cloud credentials, the coherence rule, the timeout policy, and the decision
 * that a 5xx is a failure. The route knows none of it, and a test can replace the
 * whole thing with a recording stub to exercise the handler's own behaviour.
 */
export class ElectricClient extends Context.Service<ElectricClient, ElectricClientApi>()(
	"@maple/electric-sync/ElectricClient",
	{
		make: Effect.gen(function* () {
			const config = yield* SyncConfig
			const client = yield* HttpClient.HttpClient

			// Checked on the raw `Option`s — presence is the whole question, so nothing
			// is flattened until a value is actually needed on the URL below.
			const configCoherent = isElectricConfigCoherent({
				sourceId: config.ELECTRIC_SOURCE_ID,
				secret: config.ELECTRIC_SECRET,
			})
			const electricUrl = Option.getOrUndefined(config.ELECTRIC_URL)
			const sourceId = Option.getOrUndefined(config.ELECTRIC_SOURCE_ID)
			const secret = Option.match(config.ELECTRIC_SECRET, {
				onNone: () => undefined,
				onSome: Redacted.value,
			})

			// Detect a half-configured deploy once at isolate startup rather than per
			// request, and log so the misconfiguration is discoverable in telemetry.
			if (electricUrl && !configCoherent) {
				yield* Effect.logWarning(
					"Electric sync disabled: incoherent Cloud credentials — set both ELECTRIC_SOURCE_ID and ELECTRIC_SECRET, or neither",
				).pipe(
					Effect.annotateLogs({
						hasSourceId: Option.isSome(config.ELECTRIC_SOURCE_ID),
						hasSecret: Option.isSome(config.ELECTRIC_SECRET),
					}),
				)
			}

			// Availability decided once, as a value: success carries the base URL, so
			// "we are configured" and "here is the URL to use" cannot drift apart and
			// nothing downstream has to assert the URL is present.
			const availability: Result.Result<string, ElectricNotConfigured> = !electricUrl
				? Result.fail(
						new ElectricNotConfigured({
							message: "Electric sync is not configured (no ELECTRIC_URL)",
							reason: "missing_url",
						}),
					)
				: configCoherent
					? Result.succeed(electricUrl)
					: Result.fail(
							new ElectricNotConfigured({
								message:
									"Electric Cloud credentials are half-configured (ELECTRIC_URL set, source_id/secret missing)",
								reason: "incoherent_credentials",
							}),
						)

			const ensureConfigured = Effect.asVoid(Effect.fromResult(availability))

			const fetchSubscription = Effect.fnUntraced(function* (request: SyncRequest, orgId: string) {
				const electricUrl = yield* Effect.fromResult(availability)
				const url = buildUpstreamSyncUrl({
					electricUrl,
					request,
					orgId,
					sourceId,
					secret,
				})

				// Electric `live` requests long-poll, then return a COMPLETE response
				// (not an open SSE stream), and control-plane shapes are small, so we
				// buffer the body rather than manage a scoped pass-through stream.
				const fetched = client.get(url).pipe(
					Effect.annotateSpans("peer.service", "electric"),
					Effect.flatMap((response) =>
						response.text.pipe(Effect.map((body) => ({ response, body }))),
					),
				)

				const { response, body } = yield* (
					isLiveRequest(request.clientParams)
						? fetched
						: fetched.pipe(Effect.timeout(UPSTREAM_TIMEOUT))
				).pipe(
					// One mapping for transport failures and timeouts alike: the cause
					// travels in the message instead of the mutable closure variable this
					// replaces, so the span can say what actually went wrong.
					Effect.mapError(
						(error) =>
							new ElectricUpstreamUnreachable({
								message: `Electric upstream unreachable (${request.shape}): ${describeUpstreamFailure(error)}`,
							}),
					),
					Effect.tapError((error) =>
						Effect.logWarning("Electric shape upstream request failed").pipe(
							Effect.annotateLogs({ shape: request.shape, error: error.message }),
						),
					),
				)

				if (response.status >= 500) {
					return yield* new ElectricUpstreamError({
						// The body is what Electric actually said; truncated because a
						// status description is not a place to put a whole payload.
						message: `Electric returned ${response.status} for shape ${request.shape}: ${body.slice(0, 300)}`,
						status: response.status,
						body,
						headers: { ...response.headers },
					})
				}

				return { status: response.status, headers: { ...response.headers }, body }
			})

			return { ensureConfigured, fetchShape: fetchSubscription } satisfies ElectricClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
