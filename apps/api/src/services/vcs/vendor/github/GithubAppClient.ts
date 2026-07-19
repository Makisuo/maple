import { GitCommitSha } from "@maple/domain/http"
import { Clock, Context, Data, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "../../../../lib/Env"
import { GithubHttp } from "./GithubHttp"

// ---------------------------------------------------------------------------
// GitHub App REST client. Vendor-specific: mints a short-lived App JWT (RS256,
// Web Crypto), exchanges it for per-installation tokens, and calls the GitHub
// REST API. No Octokit (Worker bundle weight). This module never touches D1.
//
// `GithubAppError` is internal to the GitHub layer; `GithubProvider` maps it to
// the generic `VcsProviderError` at the port boundary.
// ---------------------------------------------------------------------------

export class GithubAppError extends Data.TaggedError("GithubAppError")<{
	message: string
	status?: number
	// Which resource the failing call addressed, so the provider can tell an
	// installation-auth failure (the gone/suspended signal) from a repo-level one.
	scope?: "installation" | "repository"
	// Set when the failure is a rate limit too far out to wait through inline:
	// seconds until the budget returns. The provider maps this to VcsRateLimitedError.
	retryAfterSeconds?: number
	cause?: unknown
}> {}

const GITHUB_API_VERSION = "2022-11-28"
const USER_AGENT = "maple-vcs-integration"
// The user-facing OAuth host (NOT the REST API host): the App's web OAuth leg
// exchanges the install-callback `code` for a user access token here.
const GITHUB_OAUTH_BASE_URL = "https://github.com"
const PER_PAGE = 100
// Paginate effectively to the end (up to 100k items) while still bounding a
// pathological loop. Hitting this cap is logged — truncation is never silent.
const MAX_PAGES = 1000
// Pages walked per consumer invocation before yielding a continuation. Caps
// wall-clock per invocation to stay under Cloudflare Queues' 15-min limit;
// the remainder resumes from a committer-date watermark in a follow-up job.
export const COMMIT_PAGES_PER_INVOCATION = 25
// Ride out short rate limits inline; anything longer is surfaced so the caller
// can defer (backfill requeues from a cursor; other jobs get a delayed retry).
const INLINE_BACKOFF_CAP_S = 30
// Cap inline rate-limit retries so a server stuck reporting tiny/zero waits (e.g.
// a past reset timestamp from clock skew) can't spin the consumer forever; once
// hit, we defer like any other long wait rather than looping.
const MAX_INLINE_RATE_LIMIT_RETRIES = 5
// Retire a cached token this early so it never expires mid-request. Tokens last
// ~1h, so the extra minute just costs an occasional re-mint.
const INSTALLATION_TOKEN_EXPIRY_SKEW_MS = 60_000

// A GitHub rate-limit response is a 429, or a 403 that carries `retry-after` /
// reports zero remaining (the secondary-limit shape). Plain 403s (permissions)
// are NOT rate limits.
const isRateLimited = (response: Response): boolean =>
	response.status === 429 ||
	(response.status === 403 &&
		(response.headers.get("retry-after") !== null ||
			response.headers.get("x-ratelimit-remaining") === "0"))

// Seconds until the budget returns, per GitHub's guidance: prefer `retry-after`,
// else wait until the rate-limit reset (epoch seconds), else a conservative minute.
const rateLimitWaitSeconds = (response: Response, nowMs: number): number => {
	const retryAfter = response.headers.get("retry-after")
	if (retryAfter !== null) {
		const secs = Number(retryAfter)
		if (Number.isFinite(secs) && secs >= 0) return secs
		// `retry-after` may be an HTTP-date instead of delta-seconds.
		const dateMs = Date.parse(retryAfter)
		if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - nowMs) / 1000))
	}
	const reset = response.headers.get("x-ratelimit-reset")
	if (reset !== null) {
		const resetSec = Number(reset)
		if (Number.isFinite(resetSec)) return Math.max(0, Math.ceil(resetSec - nowMs / 1000))
	}
	return 60
}

// ---- REST response schemas ------------------------------------------------

const GithubInstallationTokenResponse = Schema.Struct({
	token: Schema.String,
	expires_at: Schema.String,
})

// `GET /app/installations/{id}` (App-JWT auth): the installed account + which
// repositories the installation can see. Used by the dashboard connect flow to
// populate the installation row without needing a user OAuth token.
const GithubInstallationDetailSchema = Schema.Struct({
	id: Schema.Number,
	account: Schema.NullOr(
		Schema.Struct({
			login: Schema.String,
			id: Schema.Number,
			type: Schema.String, // "User" | "Organization"
			avatar_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	repository_selection: Schema.optionalKey(Schema.String), // "all" | "selected"
})

// Response from the OAuth token exchange. GitHub returns either `access_token` or,
// even on a 200, an `error` field — so both are optional and we check which we got.
const GithubOAuthTokenResponse = Schema.Struct({
	access_token: Schema.optionalKey(Schema.String),
	token_type: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
	error: Schema.optionalKey(Schema.String),
	error_description: Schema.optionalKey(Schema.String),
})

// `GET /user/installations` — the installations this user can manage. We use it to
// confirm they actually own the one they're connecting.
const GithubUserInstallationsResponse = Schema.Struct({
	total_count: Schema.Number,
	installations: Schema.Array(Schema.Struct({ id: Schema.Number })),
})

const GithubApiRepoSchema = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	full_name: Schema.String,
	private: Schema.Boolean,
	archived: Schema.optionalKey(Schema.Boolean),
	default_branch: Schema.optionalKey(Schema.String),
	html_url: Schema.String,
	owner: Schema.Struct({ login: Schema.String }),
})
type GithubApiRepo = Schema.Schema.Type<typeof GithubApiRepoSchema>

const GithubInstallationReposResponse = Schema.Struct({
	total_count: Schema.Number,
	repositories: Schema.Array(GithubApiRepoSchema),
})

const GithubApiCommitAuthor = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	date: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const GithubApiUser = Schema.Struct({
	login: Schema.String,
	avatar_url: Schema.optionalKey(Schema.String),
})

const GithubApiCommitSchema = Schema.Struct({
	sha: GitCommitSha, // validated at decode — the 40-hex shape lives in the brand
	html_url: Schema.String,
	commit: Schema.Struct({
		message: Schema.String,
		author: Schema.NullOr(GithubApiCommitAuthor),
		committer: Schema.optionalKey(Schema.NullOr(GithubApiCommitAuthor)),
	}),
	author: Schema.NullOr(GithubApiUser),
})
export type GithubApiCommit = Schema.Schema.Type<typeof GithubApiCommitSchema>

const GithubApiCommitList = Schema.Array(GithubApiCommitSchema)

const GithubApiBranchSchema = Schema.Struct({
	name: Schema.String,
	commit: Schema.Struct({ sha: GitCommitSha }), // 40-hex validated by the brand
})
type GithubApiBranch = Schema.Schema.Type<typeof GithubApiBranchSchema>
const GithubApiBranchList = Schema.Array(GithubApiBranchSchema)

const GithubCodeSearchResponseSchema = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			sha: Schema.String,
			html_url: Schema.String,
			text_matches: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						fragment: Schema.String,
					}),
				),
			),
		}),
	),
})

const GithubContentFileSchema = Schema.Struct({
	type: Schema.Literal("file"),
	path: Schema.String,
	sha: Schema.String,
	size: Schema.Number,
	html_url: Schema.NullOr(Schema.String),
	encoding: Schema.String,
	content: Schema.String,
})

const decodeOAuthToken = Schema.decodeUnknownEffect(GithubOAuthTokenResponse)
const decodeUserInstallations = Schema.decodeUnknownEffect(GithubUserInstallationsResponse)
const decodeInstallationToken = Schema.decodeUnknownEffect(GithubInstallationTokenResponse)
const decodeInstallationDetail = Schema.decodeUnknownEffect(GithubInstallationDetailSchema)
const decodeInstallationRepos = Schema.decodeUnknownEffect(GithubInstallationReposResponse)
const decodeCommitList = Schema.decodeUnknownEffect(GithubApiCommitList)
const decodeCommit = Schema.decodeUnknownEffect(GithubApiCommitSchema)
const decodeBranchList = Schema.decodeUnknownEffect(GithubApiBranchList)
const decodeCodeSearch = Schema.decodeUnknownEffect(GithubCodeSearchResponseSchema)
const decodeContentFile = Schema.decodeUnknownEffect(GithubContentFileSchema)

// ---- JWT (RS256 via Web Crypto) -------------------------------------------

const base64UrlString = (value: string) => Buffer.from(value, "utf8").toString("base64url")
const base64UrlBytes = (value: ArrayBuffer) => Buffer.from(value).toString("base64url")

const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const body = pem
		.replace(/-----BEGIN[^-]+-----/g, "")
		.replace(/-----END[^-]+-----/g, "")
		.replace(/\s+/g, "")
	const buf = Buffer.from(body, "base64")
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

interface ResolvedAppConfig {
	readonly appId: string
	readonly privateKeyPem: string
	readonly apiBaseUrl: string
}

export class GithubAppClient extends Context.Service<GithubAppClient>()(
	"@maple/api/services/vcs/vendor/github/GithubAppClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const http = yield* GithubHttp

			// Reuse one token per installation instead of minting a fresh one per repo.
			// Tokens last ~1h; cache is per-isolate (externalInstallationId → token + expiry).
			const installationTokens = new Map<string, { token: string; expiresAtMs: number }>()

			// Run a request, riding out short rate limits inline and surfacing longer
			// ones as a GithubAppError carrying `retryAfterSeconds`.
			const rateLimitedFetch = (request: Effect.Effect<Response, GithubAppError>) =>
				Effect.gen(function* () {
					let inlineRetries = 0
					while (true) {
						const response = yield* request
						if (!isRateLimited(response)) return response
						const waitS = rateLimitWaitSeconds(response, yield* Clock.currentTimeMillis)
						// Defer (surface to the caller) when a single wait is longer than we'll
						// ride out inline, OR when we've retried inline too many times. Floor
						// the exhausted-case deferral so a tiny/zero-wait server can't drive an
						// immediate-redelivery loop after we stop spinning.
						const exhausted = inlineRetries >= MAX_INLINE_RATE_LIMIT_RETRIES
						if (waitS > INLINE_BACKOFF_CAP_S || exhausted) {
							return yield* new GithubAppError({
								message: `GitHub rate limited (retry after ${waitS}s)`,
								status: response.status,
								retryAfterSeconds: exhausted ? Math.max(waitS, 60) : waitS,
							})
						}
						inlineRetries += 1
						// Surface the inline-wait on the active HTTP span so a slow GitHub call
						// is attributable to throttling (not network latency) from the trace.
						yield* Effect.annotateCurrentSpan({
							"vcs.provider.rate_limited": true,
							"vcs.provider.rate_limit_wait_s": waitS,
						})
						yield* Effect.logWarning("[GitHub] Rate limit hit — waiting inline").pipe(
							Effect.annotateLogs({
								waitSeconds: waitS,
								status: response.status,
								attempt: inlineRetries,
							}),
						)
						yield* Effect.sleep(Duration.seconds(waitS))
					}
				})

			const resolveConfig: Effect.Effect<ResolvedAppConfig, GithubAppError> = Effect.gen(function* () {
				const appId = Option.getOrUndefined(env.GITHUB_APP_ID)
				const privateKey = Option.getOrUndefined(env.GITHUB_APP_PRIVATE_KEY)
				if (!appId || !privateKey) {
					return yield* new GithubAppError({
						message:
							"GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
					})
				}
				return {
					appId,
					privateKeyPem: Redacted.value(privateKey),
					apiBaseUrl: env.GITHUB_API_BASE_URL.replace(/\/+$/, ""),
				}
			})

			const importSigningKey = (pem: string) =>
				Effect.tryPromise({
					try: () =>
						crypto.subtle.importKey(
							"pkcs8",
							pemToPkcs8(pem),
							{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
							false,
							["sign"],
						),
					catch: (cause) =>
						new GithubAppError({ message: "Failed to import GitHub App private key", cause }),
				})

			const mintAppJwt = Effect.fn("GithubAppClient.mintAppJwt")(function* (config: ResolvedAppConfig) {
				const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const header = base64UrlString(JSON.stringify({ alg: "RS256", typ: "JWT" }))
				// iat back-dated 60s for clock skew; exp ≤ 10min per GitHub's limit.
				const payload = base64UrlString(
					JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: config.appId }),
				)
				const signingInput = `${header}.${payload}`
				const key = yield* importSigningKey(config.privateKeyPem)
				const signature = yield* Effect.tryPromise({
					try: () =>
						crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
					catch: (cause) => new GithubAppError({ message: "JWT signing failed", cause }),
				})
				return `${signingInput}.${base64UrlBytes(signature)}`
			})

			// ---- HTTP helpers ---------------------------------------------

			const failure = (response: Response, context: string, scope?: "installation" | "repository") =>
				Effect.gen(function* () {
					const body = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: () =>
							new GithubAppError({
								message: `${context} failed`,
								status: response.status,
								scope,
							}),
					})
					return yield* Effect.fail(
						new GithubAppError({
							message: `${context} failed: ${response.status} ${body.slice(0, 300)}`,
							status: response.status,
							scope,
						}),
					)
				})

			const parseJson = (response: Response, context: string) =>
				Effect.tryPromise({
					try: () => response.json() as Promise<unknown>,
					catch: (cause) =>
						new GithubAppError({ message: `${context} returned a non-JSON response`, cause }),
				})

			const mintInstallationToken = Effect.fn("GithubAppClient.mintInstallationToken")(function* (
				externalInstallationId: string,
			) {
				// Return a cached token if it's still good, so we don't re-mint per repo.
				const now = yield* Clock.currentTimeMillis
				const cached = installationTokens.get(externalInstallationId)
				if (cached !== undefined && cached.expiresAtMs - INSTALLATION_TOKEN_EXPIRY_SKEW_MS > now) {
					yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "hit" })
					return cached.token
				}
				yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "miss" })

				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* rateLimitedFetch(
					Effect.tryPromise({
						try: () =>
							http.fetch(
								`${config.apiBaseUrl}/app/installations/${externalInstallationId}/access_tokens`,
								{
									method: "POST",
									headers: {
										authorization: `Bearer ${jwt}`,
										accept: "application/vnd.github+json",
										"x-github-api-version": GITHUB_API_VERSION,
										"user-agent": USER_AGENT,
									},
								},
							),
						catch: (cause) =>
							new GithubAppError({ message: "Installation token request failed", cause }),
					}),
				)
				// A non-rate-limit failure here is the installation auth gate — the
				// authoritative "installation gone / suspended" signal (rate limits were
				// already split off by rateLimitedFetch above).
				if (!response.ok)
					return yield* failure(response, "Installation token request", "installation")
				const json = yield* parseJson(response, "Installation token request")
				const decoded = yield* decodeInstallationToken(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected installation token payload", cause }),
					),
				)
				// Cache it. If we can't read the expiry, skip caching rather than risk
				// reusing a token forever.
				const expiresAtMs = Date.parse(decoded.expires_at)
				if (Number.isFinite(expiresAtMs)) {
					installationTokens.set(externalInstallationId, { token: decoded.token, expiresAtMs })
				}
				return decoded.token
			})

			const authedGet = (_config: ResolvedAppConfig, token: string, url: string) =>
				rateLimitedFetch(
					Effect.tryPromise({
						try: () =>
							http.fetch(url, {
								headers: {
									authorization: `token ${token}`,
									accept: "application/vnd.github+json",
									"x-github-api-version": GITHUB_API_VERSION,
									"user-agent": USER_AGENT,
								},
							}),
						catch: (cause) =>
							new GithubAppError({ message: `GitHub request failed: ${url}`, cause }),
					}),
				)

			const listInstallationRepositories = Effect.fn("GithubAppClient.listInstallationRepositories")(
				function* (externalInstallationId: string) {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const repos: Array<GithubApiRepo> = []
					let page = 1
					for (; page <= MAX_PAGES; page++) {
						const response = yield* authedGet(
							config,
							token,
							`${config.apiBaseUrl}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!response.ok) return yield* failure(response, "List installation repositories")
						const json = yield* parseJson(response, "List installation repositories")
						const decoded = yield* decodeInstallationRepos(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({
										message: "Unexpected installation repositories payload",
										cause,
									}),
							),
						)
						repos.push(...decoded.repositories)
						if (decoded.repositories.length < PER_PAGE) break
					}
					// Exhausted the page cap without a short final page → likely truncated.
					if (page > MAX_PAGES) {
						yield* Effect.logWarning(
							"[GitHub] Installation repositories truncated at page cap",
						).pipe(
							Effect.annotateLogs({
								externalInstallationId,
								maxPages: MAX_PAGES,
								fetched: repos.length,
							}),
						)
					}
					return repos
				},
			)

			// Returns `truncated` when the page cap is hit so the caller can skip
			// delete-reconciliation. Scoped to "repository" so a 404 means "repo
			// unavailable", not "no branches".
			const listBranches = Effect.fn("GithubAppClient.listBranches")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
				const branches: Array<GithubApiBranch> = []
				let page = 1
				for (; page <= MAX_PAGES; page++) {
					const response = yield* authedGet(
						config,
						token,
						`${base}?per_page=${PER_PAGE}&page=${page}`,
					)
					if (!response.ok) return yield* failure(response, "List branches", "repository")
					const json = yield* parseJson(response, "List branches")
					const decoded = yield* decodeBranchList(json).pipe(
						Effect.mapError(
							(cause) => new GithubAppError({ message: "Unexpected branches payload", cause }),
						),
					)
					branches.push(...decoded)
					if (decoded.length < PER_PAGE) break
				}
				const truncated = page > MAX_PAGES
				if (truncated) {
					yield* Effect.logWarning("[GitHub] Branches truncated at page cap").pipe(
						Effect.annotateLogs({ owner, repo, maxPages: MAX_PAGES, fetched: branches.length }),
					)
				}
				return { branches, truncated }
			})

			// Returns commits page-by-page until the window is exhausted OR the
			// per-invocation page budget is hit. Two ways a walk is cut short, both
			// reported as a *partial* result (commits kept, never refetched) so the
			// caller can checkpoint + requeue:
			//  - `"rate-limited"`: a rate limit too far out to ride inline (from the
			//    token mint OR any page), caught at the outer level.
			//  - `"page-budget"`: `COMMIT_PAGES_PER_INVOCATION` full pages fetched with
			//    more to come — yield so one invocation stays under the queue's limit.
			const listCommits = Effect.fn("GithubAppClient.listCommits")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				params: { sha?: string; sinceIso?: string; untilIso?: string },
			) {
				const commits: Array<GithubApiCommit> = []
				const outcome = yield* Effect.gen(function* () {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`
					for (let page = 1; page <= COMMIT_PAGES_PER_INVOCATION; page++) {
						const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) })
						if (params.sha) query.set("sha", params.sha)
						if (params.sinceIso) query.set("since", params.sinceIso)
						if (params.untilIso) query.set("until", params.untilIso)
						const response = yield* authedGet(config, token, `${base}?${query.toString()}`)
						// 409 = empty repository → genuinely no commits, not an error.
						if (response.status === 409) return { complete: true as const }
						// Anything else non-2xx (incl. 404 = repo deleted / access lost) is
						// surfaced as a repository-scoped failure so the orchestrator can mark
						// the repo unavailable rather than mistaking it for an empty repo.
						if (!response.ok) return yield* failure(response, "List commits", "repository")
						const json = yield* parseJson(response, "List commits")
						const decoded = yield* decodeCommitList(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected commits payload", cause }),
							),
						)
						commits.push(...decoded)
						if (decoded.length < PER_PAGE) return { complete: true as const }
					}
					// Full final page with no break → more remain; yield a continuation.
					return { complete: false as const, reason: "page-budget" as const }
				}).pipe(
					Effect.catch((error) =>
						error.retryAfterSeconds === undefined
							? Effect.fail(error)
							: Effect.succeed({
									complete: false as const,
									reason: "rate-limited" as const,
									retryAfterSeconds: error.retryAfterSeconds,
								}),
					),
				)
				if (outcome.complete) return { commits, complete: true as const }
				return outcome.reason === "rate-limited"
					? {
							commits,
							complete: false as const,
							reason: "rate-limited" as const,
							retryAfterSeconds: outcome.retryAfterSeconds,
						}
					: { commits, complete: false as const, reason: "page-budget" as const }
			})

			const getCommit = Effect.fn("GithubAppClient.getCommit")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				sha: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}`,
				)
				if (!response.ok) return yield* failure(response, "Get commit", "repository")
				const json = yield* parseJson(response, "Get commit")
				return yield* decodeCommit(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected commit payload", cause }),
					),
				)
			})

			const searchCode = Effect.fn("GithubAppClient.searchCode")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				queryText: string,
				path: string | undefined,
				limit: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const query = [queryText, `repo:${owner}/${repo}`, path ? `path:${path}` : undefined]
					.filter((part): part is string => part !== undefined)
					.join(" ")
				const params = new URLSearchParams({ q: query, per_page: String(limit), page: "1" })
				const response = yield* rateLimitedFetch(
					Effect.tryPromise({
						try: () =>
							http.fetch(`${config.apiBaseUrl}/search/code?${params.toString()}`, {
								headers: {
									authorization: `token ${token}`,
									accept: "application/vnd.github.text-match+json",
									"x-github-api-version": GITHUB_API_VERSION,
									"user-agent": USER_AGENT,
								},
							}),
						catch: (cause) => new GithubAppError({ message: "GitHub code search failed", cause }),
					}),
				)
				if (!response.ok) return yield* failure(response, "Search code", "repository")
				const json = yield* parseJson(response, "Search code")
				return yield* decodeCodeSearch(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected code search payload", cause }),
					),
				)
			})

			const getSourceFile = Effect.fn("GithubAppClient.getSourceFile")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				path: string,
				ref: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const encodedPath = path.split("/").map(encodeURIComponent).join("/")
				const params = new URLSearchParams({ ref })
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?${params.toString()}`,
				)
				if (!response.ok) return yield* failure(response, "Get repository file", "repository")
				const json = yield* parseJson(response, "Get repository file")
				return yield* decodeContentFile(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected repository file payload", cause }),
					),
				)
			})

			// Used by the dashboard connect flow to populate the installation row.
			const getInstallation = Effect.fn("GithubAppClient.getInstallation")(function* (
				externalInstallationId: string,
			) {
				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* rateLimitedFetch(
					Effect.tryPromise({
						try: () =>
							http.fetch(`${config.apiBaseUrl}/app/installations/${externalInstallationId}`, {
								headers: {
									authorization: `Bearer ${jwt}`,
									accept: "application/vnd.github+json",
									"x-github-api-version": GITHUB_API_VERSION,
									"user-agent": USER_AGENT,
								},
							}),
						catch: (cause) =>
							new GithubAppError({ message: "Get installation request failed", cause }),
					}),
				)
				if (!response.ok) return yield* failure(response, "Get installation", "installation")
				const json = yield* parseJson(response, "Get installation")
				return yield* decodeInstallationDetail(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected installation payload", cause }),
					),
				)
			})

			// ---- User OAuth leg ----
			// The two calls below prove the user owns the installation they're connecting.

			// Trade the callback `code` for a short-lived user token.
			const exchangeUserOAuthCode = Effect.fn("GithubAppClient.exchangeUserOAuthCode")(function* (
				code: string,
			) {
				const clientId = Option.getOrUndefined(env.GITHUB_APP_CLIENT_ID)
				const clientSecret = Option.getOrUndefined(env.GITHUB_APP_CLIENT_SECRET)
				if (!clientId || !clientSecret) {
					return yield* new GithubAppError({
						message:
							"GitHub App OAuth is not configured (set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET)",
					})
				}
				const body = new URLSearchParams({
					client_id: clientId,
					client_secret: Redacted.value(clientSecret),
					code,
				})
				const response = yield* rateLimitedFetch(
					Effect.tryPromise({
						try: () =>
							http.fetch(`${GITHUB_OAUTH_BASE_URL}/login/oauth/access_token`, {
								method: "POST",
								headers: {
									accept: "application/json",
									"content-type": "application/x-www-form-urlencoded",
									"user-agent": USER_AGENT,
								},
								body: body.toString(),
							}),
						catch: (cause) =>
							new GithubAppError({ message: "GitHub OAuth code exchange failed", cause }),
					}),
				)
				if (!response.ok) return yield* failure(response, "GitHub OAuth code exchange")
				const json = yield* parseJson(response, "GitHub OAuth code exchange")
				const decoded = yield* decodeOAuthToken(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected OAuth token payload", cause }),
					),
				)
				// GitHub reports OAuth errors as a 200 with an `error` field, not an HTTP error.
				if (!decoded.access_token) {
					return yield* new GithubAppError({
						message: `GitHub OAuth code exchange rejected: ${decoded.error_description ?? decoded.error ?? "no access_token"}`,
						status: 401,
					})
				}
				return decoded.access_token
			})

			const listUserInstallationIds = Effect.fn("GithubAppClient.listUserInstallationIds")(function* (
				userAccessToken: string,
			) {
				const config = yield* resolveConfig
				const ids = new Set<string>()
				for (let page = 1; page <= MAX_PAGES; page++) {
					const response = yield* authedGet(
						config,
						userAccessToken,
						`${config.apiBaseUrl}/user/installations?per_page=${PER_PAGE}&page=${page}`,
					)
					if (!response.ok) return yield* failure(response, "List user installations")
					const json = yield* parseJson(response, "List user installations")
					const decoded = yield* decodeUserInstallations(json).pipe(
						Effect.mapError(
							(cause) =>
								new GithubAppError({
									message: "Unexpected user installations payload",
									cause,
								}),
						),
					)
					for (const installation of decoded.installations) ids.add(String(installation.id))
					if (decoded.installations.length < PER_PAGE) break
				}
				return ids
			})

			return {
				mintInstallationToken,
				listInstallationRepositories,
				listBranches,
				listCommits,
				getCommit,
				searchCode,
				getSourceFile,
				getInstallation,
				exchangeUserOAuthCode,
				listUserInstallationIds,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
