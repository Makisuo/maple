import { afterEach, assert, describe, it } from "@effect/vitest"
import { randomUUID } from "node:crypto"
import {
	GitCommitSha,
	VcsInstallation,
	VcsInstallationGoneError,
	VcsProviderError,
	VcsRateLimitedError,
	VcsRepoDecodeError,
	VcsRepoUnavailableError,
	VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"
import { Clock, Effect, Exit, Layer, Option, Schema } from "effect"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@/lib/test-pglite"
import { COMMIT_PAGES_PER_INVOCATION, GithubAppClient } from "@/services/vcs/vendor/github/GithubAppClient"
import { GithubHttp } from "@/services/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "@/services/vcs/vendor/github/GithubProvider"
import type { VcsProviderClient } from "@/services/vcs/VcsProviderClient"
import { VcsProviderRegistry, type VcsProviderRegistryShape } from "@/services/vcs/VcsProviderRegistry"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import { clampQueueDelaySeconds } from "@/services/vcs/VcsSyncQueue"
import { BACKFILL_WINDOW_MS, MAX_BACKFILL_STALL_RETRIES, VcsSyncService } from "@/services/vcs/VcsSyncService"
import {
	asOrgId,
	asUserId,
	expectSome,
	findError,
	GITHUB_APP_CONFIG,
	installationFor,
	jsonResponse,
	markInstStatusFor,
	markRemovedFor,
	purgeInstallationFor,
	recordingQueueLayer,
	repoFor,
	reposOfInstallation,
	scriptedHttp,
	sign,
	testEnv,
	testRepoLayer,
	upsertCommitsFor,
	upsertReposFor,
	type VcsRepo,
	WEBHOOK_SECRET,
} from "./harness"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const SHA = "abc1230000000000000000000000000000000def"

const repoLayer = (testDb: TestDb) => testRepoLayer(testDb)

// GithubProvider over the real GithubHttp; only the webhook-parse path (no HTTP)
// is exercised through it, so the live fetch layer is never actually invoked.
const providerLayer = () => {
	const env = testEnv({ GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET })
	const client = GithubAppClient.layer.pipe(Layer.provide(Layer.mergeAll(env, GithubHttp.layer)))
	return GithubProvider.layer.pipe(Layer.provide(Layer.mergeAll(env, client)))
}

// Same as providerLayer but with NO webhook secret configured — exercises the
// operator-misconfig (`secret_not_configured`) signature-rejection branch.
const providerLayerNoSecret = () => {
	const env = testEnv()
	const client = GithubAppClient.layer.pipe(Layer.provide(Layer.mergeAll(env, GithubHttp.layer)))
	return GithubProvider.layer.pipe(Layer.provide(Layer.mergeAll(env, client)))
}

// Build a GithubProvider whose HTTP responses are scripted in call order. The
// first call is always the installation-token mint.
const stubbedProviderLayer = (responders: ReadonlyArray<() => Response>) => {
	const http = scriptedHttp(responders)
	const env = testEnv({ ...GITHUB_APP_CONFIG, GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET })
	const client = GithubAppClient.layer.pipe(Layer.provide(Layer.mergeAll(env, http)))
	return GithubProvider.layer.pipe(Layer.provide(Layer.mergeAll(env, client)))
}

const tokenResponse = () => jsonResponse({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" })

const commitJson = (sha: string) => ({
	sha,
	html_url: `https://github.com/octo/repo/commit/${sha}`,
	commit: {
		message: "m",
		author: { name: "A", email: "a@x.io", date: "2026-01-01T00:00:00Z" },
		committer: { date: "2026-01-01T00:00:00Z" },
	},
	author: { login: "octo" },
})

const commitsResponse = (shas: ReadonlyArray<string>) => jsonResponse(shas.map(commitJson))

// 429 carrying retry-after (seconds): 0 ⇒ ride out inline; large ⇒ defer.
const rateLimited = (retryAfterSeconds: number) =>
	new Response("rate limited", { status: 429, headers: { "retry-after": String(retryAfterSeconds) } })

const hexShas = (count: number) => Array.from({ length: count }, (_, n) => n.toString(16).padStart(40, "0"))

describe("VcsSyncJob", () => {
	// One smoke test over every union member: confirms each kind survives the
	// encode → wire → decode round-trip the queue relies on (the discriminator and
	// any optional keys are preserved). Per-kind behavior is covered by the provider
	// and orchestrator suites; this just guards the transport schema.
	it("round-trips every job kind through encode/decode", () => {
		const jobs: VcsSyncJob[] = [
			{
				kind: "push",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				branch: "main",
				commits: [
					{
						sha: SHA,
						message: "hello",
						authorName: "Octo",
						authorEmail: "o@x.io",
						authorLogin: "octocat",
						authorAvatarUrl: null,
						authoredAt: 1,
						committedAt: 2,
						htmlUrl: "https://github.com/o/r/commit/x",
					},
				],
			},
			{
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "created",
			},
			{
				kind: "sync-branches",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
			},
			{
				kind: "branch-event",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				action: "created",
				branch: "feature/x",
			},
			{
				kind: "sync-commits",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				branch: "release/2",
				sinceMs: 100,
			},
		]
		for (const job of jobs) {
			const wire = JSON.parse(JSON.stringify(Schema.encodeSync(VcsSyncJob)(job)))
			assert.deepStrictEqual(Schema.decodeUnknownSync(VcsSyncJob)(wire), job)
		}
	})
})

describe("GithubProvider.webhookToJobs", () => {
	const pushBody = JSON.stringify({
		ref: "refs/heads/main",
		repository: { id: 7, owner: { login: "octo" } },
		installation: { id: 42 },
		after: SHA,
		commits: [
			{
				id: SHA,
				message: "hello world",
				timestamp: "2026-01-01T00:00:00Z",
				url: `https://github.com/octo/repo/commit/${SHA}`,
				author: { name: "Octo Cat", email: "octo@x.io", username: "octocat" },
			},
		],
	})

	it.effect("maps a validly-signed push to a push job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(pushBody) },
				rawBody: pushBody,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "push")
			if (job.kind !== "push") return
			assert.strictEqual(job.externalInstallationId, "42")
			assert.strictEqual(job.externalRepoId, "7")
			assert.strictEqual(job.branch, "main")
			assert.strictEqual(job.commits.length, 1)
			assert.strictEqual(job.commits[0]!.sha, SHA)
			assert.strictEqual(job.commits[0]!.authorLogin, "octocat")
			// Push payloads carry no avatar URL — the provider derives one from the
			// committer login against the commit's own host (here github.com), so the
			// dashboard never has to patch a null avatar.
			assert.strictEqual(
				job.commits[0]!.authorAvatarUrl,
				"https://github.com/octocat.png?size=64",
			)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("derives a push commit's avatar against its own host (GitHub Enterprise)", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				commits: [
					{
						id: SHA,
						message: "enterprise commit",
						timestamp: "2026-01-01T00:00:00Z",
						url: `https://github.acme.com/octo/repo/commit/${SHA}`,
						author: { name: "Octo Cat", email: "octo@x.io", username: "octocat" },
					},
				],
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			const job = jobs[0]!
			if (job.kind !== "push") return assert.fail("expected a push job")
			assert.strictEqual(
				job.commits[0]!.authorAvatarUrl,
				"https://github.acme.com/octocat.png?size=64",
			)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("leaves a push commit's avatar null when the committer has no login", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				commits: [
					{
						id: SHA,
						message: "no linked account",
						timestamp: "2026-01-01T00:00:00Z",
						url: `https://github.com/octo/repo/commit/${SHA}`,
						author: { name: "Octo Cat", email: "octo@x.io" },
					},
				],
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			const job = jobs[0]!
			if (job.kind !== "push") return assert.fail("expected a push job")
			assert.strictEqual(job.commits[0]!.authorLogin, null)
			assert.strictEqual(job.commits[0]!.authorAvatarUrl, null)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("rejects an invalid signature with VcsWebhookSignatureError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider
				.webhookToJobs({
					headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=deadbeef" },
					rawBody: pushBody,
				})
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookSignatureError)
		}).pipe(Effect.provide(providerLayer())),
	)

	// Cloudflare Queue caps at 128 KB; a large push splits by byte size, not commit count.
	it.effect("splits a large push into multiple jobs that each stay under the 128 KB queue cap", () =>
		Effect.gen(function* () {
			const QUEUE_MESSAGE_LIMIT = 128 * 1024
			const provider = yield* GithubProvider
			const shas = hexShas(400)
			const message = "x".repeat(1024) // ~1 KB messages ⇒ ~440 KB total ⇒ several jobs
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				commits: shas.map((sha) => ({
					id: sha,
					message,
					timestamp: "2026-01-01T00:00:00Z",
					url: `https://github.com/octo/repo/commit/${sha}`,
					author: { name: "Octo Cat", email: "octo@x.io", username: "octocat" },
				})),
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.ok(jobs.length > 1)
			for (const job of jobs) {
				assert.strictEqual(job.kind, "push")
				if (job.kind !== "push") return
				// Every job is independently enqueueable, regardless of the (count-blind) split.
				const wireBytes = Buffer.byteLength(JSON.stringify(Schema.encodeSync(VcsSyncJob)(job)))
				assert.ok(wireBytes < QUEUE_MESSAGE_LIMIT)
				assert.strictEqual(job.externalInstallationId, "42")
				assert.strictEqual(job.externalRepoId, "7")
				assert.strictEqual(job.branch, "main")
			}
			// Every commit is preserved across the slices, in order — none dropped.
			const splitShas = jobs.flatMap((job) =>
				job.kind === "push" ? job.commits.map((c) => c.sha) : [],
			)
			assert.deepStrictEqual(splitShas, shas)
		}).pipe(Effect.provide(providerLayer())),
	)

	// Force-push rewrote history: payload unreliable, so the provider discards it and
	// emits a single marker job. The orchestrator re-walks instead of trusting the payload.
	it.effect("a forced push emits a single empty marker job (no commits, no split)", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const shas = hexShas(400)
			const message = "x".repeat(1024) // ~1 KB messages ⇒ several jobs
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				forced: true,
				commits: shas.map((sha) => ({
					id: sha,
					message,
					timestamp: "2026-01-01T00:00:00Z",
					url: `https://github.com/octo/repo/commit/${sha}`,
					author: { name: "Octo Cat", email: "octo@x.io", username: "octocat" },
				})),
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "push")
			if (job.kind !== "push") return
			assert.strictEqual(job.forced, true)
			assert.deepStrictEqual(job.commits, []) // payload discarded; the orchestrator re-walks
			assert.strictEqual(job.branch, "main")
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("maps an installation 'created' event to an installation-sync job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({ action: "created", installation: { id: 99 } })
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "installation", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "installation-sync")
			if (job.kind !== "installation-sync") return
			assert.strictEqual(job.reason, "created")
			assert.strictEqual(job.externalInstallationId, "99")
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("maps a branch 'create' event to a branch-event created job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "feature/x",
				ref_type: "branch",
				repository: { id: 7 },
				installation: { id: 42 },
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "create", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "branch-event")
			if (job.kind !== "branch-event") return
			assert.strictEqual(job.action, "created")
			assert.strictEqual(job.branch, "feature/x")
			assert.strictEqual(job.externalRepoId, "7")
			assert.strictEqual(job.externalInstallationId, "42")
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("maps a branch 'delete' event to a branch-event deleted job", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "feature/x",
				ref_type: "branch",
				repository: { id: 7 },
				installation: { id: 42 },
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "delete", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			assert.strictEqual(job.kind, "branch-event")
			if (job.kind !== "branch-event") return
			assert.strictEqual(job.action, "deleted")
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("ignores a tag create/delete (ref_type=tag)", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "v1.0.0",
				ref_type: "tag",
				repository: { id: 7 },
				installation: { id: 42 },
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "create", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 0)
		}).pipe(Effect.provide(providerLayer())),
	)

	// installation events: every recognized action maps to its sync reason; an
	// unrecognized action is ignored (no job). The "created" case is covered above.
	it.effect("maps installation lifecycle actions to their sync reasons (ignoring unknown ones)", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const cases = [
				{ action: "unsuspend", reason: "unsuspend" },
				{ action: "suspend", reason: "suspend" },
				{ action: "deleted", reason: "deleted" },
			] as const
			for (const { action, reason } of cases) {
				const body = JSON.stringify({ action, installation: { id: 99 } })
				const jobs = yield* provider.webhookToJobs({
					headers: { "x-github-event": "installation", "x-hub-signature-256": sign(body) },
					rawBody: body,
				})
				assert.strictEqual(jobs.length, 1, `${action} → one job`)
				const job = jobs[0]!
				assert.strictEqual(job.kind, "installation-sync")
				if (job.kind !== "installation-sync") return
				assert.strictEqual(job.reason, reason)
				assert.strictEqual(job.externalInstallationId, "99")
			}
			// An action we don't act on (e.g. new_permissions_accepted) is dropped.
			const ignoredBody = JSON.stringify({
				action: "new_permissions_accepted",
				installation: { id: 99 },
			})
			const ignored = yield* provider.webhookToJobs({
				headers: { "x-github-event": "installation", "x-hub-signature-256": sign(ignoredBody) },
				rawBody: ignoredBody,
			})
			assert.strictEqual(ignored.length, 0)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("maps installation_repositories added/removed to repositories_added/removed jobs", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const cases = [
				{ action: "added", reason: "repositories_added" },
				{ action: "removed", reason: "repositories_removed" },
			] as const
			for (const { action, reason } of cases) {
				const body = JSON.stringify({ action, installation: { id: 99 } })
				const jobs = yield* provider.webhookToJobs({
					headers: {
						"x-github-event": "installation_repositories",
						"x-hub-signature-256": sign(body),
					},
					rawBody: body,
				})
				assert.strictEqual(jobs.length, 1, `${action} → one job`)
				const job = jobs[0]!
				assert.strictEqual(job.kind, "installation-sync")
				if (job.kind !== "installation-sync") return
				assert.strictEqual(job.reason, reason)
				assert.strictEqual(job.externalInstallationId, "99")
			}
		}).pipe(Effect.provide(providerLayer())),
	)

	// Signature is the security boundary; each rejection reason is a distinct branch.
	// A missing header must be rejected BEFORE any HMAC compute (the existing
	// invalid-signature test only covers the `mismatch` branch).
	it.effect("rejects a missing x-hub-signature-256 header with VcsWebhookSignatureError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider
				.webhookToJobs({ headers: { "x-github-event": "push" }, rawBody: pushBody })
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookSignatureError)
		}).pipe(Effect.provide(providerLayer())),
	)

	// A header without the `sha256=` prefix is malformed — a separate branch from a
	// well-formed-but-wrong signature.
	it.effect("rejects a malformed (prefix-less) signature header with VcsWebhookSignatureError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider
				.webhookToJobs({
					headers: { "x-github-event": "push", "x-hub-signature-256": "deadbeef" },
					rawBody: pushBody,
				})
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookSignatureError)
		}).pipe(Effect.provide(providerLayer())),
	)

	// Operator misconfig: no webhook secret set. Every webhook must be rejected (never
	// silently accepted) — a distinct reason from an attacker mismatch.
	it.effect("rejects every webhook with VcsWebhookSignatureError when no secret is configured", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider
				.webhookToJobs({
					headers: { "x-github-event": "push", "x-hub-signature-256": sign(pushBody) },
					rawBody: pushBody,
				})
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookSignatureError)
		}).pipe(Effect.provide(providerLayerNoSecret())),
	)

	// A push to a non-branch ref (e.g. a tag push) carries no branch — it must be
	// dropped, not sliced into a garbage branch name.
	it.effect("ignores a push to a non-branch ref (refs/tags/…)", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/tags/v1.0.0",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				after: SHA,
				commits: [
					{
						id: SHA,
						message: "tagged",
						timestamp: "2026-01-01T00:00:00Z",
						url: `https://github.com/octo/repo/commit/${SHA}`,
						author: { name: "Octo", email: "o@x.io", username: "octo" },
					},
				],
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 0)
		}).pipe(Effect.provide(providerLayer())),
	)

	// A branch-pointer move with no new commits (non-forced) emits no job — the split
	// loop must never enqueue an empty-commit push.
	it.effect("emits no job for a non-forced push with an empty commit list", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				after: SHA,
				commits: [],
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 0)
		}).pipe(Effect.provide(providerLayer())),
	)

	// Only the `refs/heads/` prefix is stripped — a branch name with slashes survives
	// intact (guards against a "strip all heads/" regression).
	it.effect("preserves slashes in a branch name when stripping refs/heads/", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/feature/a/b",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				after: SHA,
				commits: [
					{
						id: SHA,
						message: "m",
						timestamp: "2026-01-01T00:00:00Z",
						url: `https://github.com/octo/repo/commit/${SHA}`,
						author: { name: "Octo", email: "o@x.io", username: "octo" },
					},
				],
			})
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 1)
			const job = jobs[0]!
			if (job.kind !== "push") return
			assert.strictEqual(job.branch, "feature/a/b")
		}).pipe(Effect.provide(providerLayer())),
	)

	// An unrecognized event (e.g. GitHub's `ping`, sent on every webhook reconfigure)
	// is accepted as a no-op — it must NOT throw / 500 the receiver.
	it.effect("accepts an unhandled event (ping) as a no-op", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({ zen: "Keep it simple", hook_id: 1 })
			const jobs = yield* provider.webhookToJobs({
				headers: { "x-github-event": "ping", "x-hub-signature-256": sign(body) },
				rawBody: body,
			})
			assert.strictEqual(jobs.length, 0)
		}).pipe(Effect.provide(providerLayer())),
	)
})

describe("GithubProvider.fetchBranches", () => {
	it.effect("lists branch names + heads and reports not-truncated", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			// fetchBranches only reads externalInstallationId off the installation.
			const installation = { externalInstallationId: "42" } as unknown as VcsInstallation
			const result = yield* provider.fetchBranches(installation, {
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
			})
			assert.strictEqual(result.truncated, false)
			// The provider is oblivious to which branch is the default (the repo layer
			// derives that display hint) — it returns names + heads only.
			assert.deepStrictEqual(
				[...result.branches].sort((a, b) => a.name.localeCompare(b.name)),
				[
					{ name: "feature", headSha: "b".repeat(40) },
					{ name: "main", headSha: "a".repeat(40) },
				],
			)
		}).pipe(
			Effect.provide(
				stubbedProviderLayer([
					tokenResponse,
					() =>
						jsonResponse([
							{ name: "main", commit: { sha: "a".repeat(40) } },
							{ name: "feature", commit: { sha: "b".repeat(40) } },
						]),
				]),
			),
		),
	)
})

describe("VcsRepository", () => {
	it.effect("branches: upsert list, tracked-branch change wipes commits, reconcile, delete", () => {
		const testDb = createTestDb(trackedDbs)
		const SHA_X = "a".repeat(40)
		const SHA_Y = "b".repeat(40)
		const mk = (sha: string, committedAt: number) => ({
			sha,
			message: "m",
			authorName: null,
			authorEmail: null,
			authorLogin: null,
			authorAvatarUrl: null,
			authoredAt: null,
			committedAt,
			htmlUrl: `https://github.com/o/r/commit/${sha}`,
		})
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_branch")
			yield* repo.upsertInstallation({
				orgId,
				provider: "github",
				externalInstallationId: "42",
				accountLogin: "octo",
				accountType: "organization",
				externalAccountId: "100",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: asUserId("user_1"),
			})
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			let r = yield* repoFor(repo, orgId, "7")
			// The tracked branch is seeded to the repo's default on discovery.
			assert.strictEqual(r.trackedBranch, "main")

			yield* repo.upsertBranches(r, [
				{ name: "main", headSha: null },
				{ name: "feature", headSha: null },
				{ name: "stale", headSha: null },
			])
			const branches = yield* repo.listBranchesByRepository(r.id)
			assert.strictEqual(branches.length, 3)
			// isDefault is a display hint derived from the repo's defaultBranch ("main");
			// the branch table no longer carries a per-branch tracked flag.
			assert.ok(branches.find((b) => b.name === "main")!.isDefault)
			assert.ok(branches.filter((b) => b.name !== "main").every((b) => !b.isDefault))

			yield* repo.upsertCommits(r, [mk(SHA_X, 100), mk(SHA_Y, 200)])
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_X as never)))

			// Changing the tracked branch wipes the repo's stored (old-branch) commits.
			yield* repo.changeTrackedBranch(orgId, r.id, "feature")
			r = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(r.trackedBranch, "feature")
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_X as never)))
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_Y as never)))

			// Reconcile: remote lacks "stale" → deleted; its name is returned.
			const deleted = yield* repo.reconcileBranchDeletions(r.id, new Set(["main", "feature"]), {
				truncated: false,
			})
			assert.deepStrictEqual([...deleted], ["stale"])
			assert.deepStrictEqual((yield* repo.listBranchesByRepository(r.id)).map((b) => b.name).sort(), [
				"feature",
				"main",
			])
			// A truncated listing is never authoritative → no deletions, empty result.
			const none = yield* repo.reconcileBranchDeletions(r.id, new Set(["main"]), { truncated: true })
			assert.strictEqual(none.length, 0)
			assert.strictEqual((yield* repo.listBranchesByRepository(r.id)).length, 2)

			assert.ok(yield* repo.deleteBranch(r.id, "feature"))
			assert.deepStrictEqual(
				(yield* repo.listBranchesByRepository(r.id)).map((b) => b.name),
				["main"],
			)
			// Deleting an absent branch is a reported no-op.
			assert.ok(!(yield* repo.deleteBranch(r.id, "feature")))
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	it.effect("upserts + reads an installation and commits (validated)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const installation = yield* repo.upsertInstallation({
				orgId,
				provider: "github",
				externalInstallationId: "42",
				accountLogin: "octo",
				accountType: "organization",
				externalAccountId: "100",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: asUserId("user_1"),
			})
			assert.strictEqual(installation.orgId, orgId)
			assert.strictEqual(installation.accountType, "organization")

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.externalInstallationId, "42")
			// status is not passed to upsertInstallation — it comes from the schema default.
			assert.strictEqual(found.value.status, "active")

			// A commit requires its repo row to exist first (it references it by id).
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const repoRow = yield* repo.resolveRepository(orgId, "github", "7")
			assert.ok(Option.isSome(repoRow))

			const count = yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: SHA,
					message: "hello",
					authorName: "Octo",
					authorEmail: null,
					authorLogin: "octocat",
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 123,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					branch: "main",
				},
			])
			assert.strictEqual(count, 1)

			const commit = yield* repo.findCommitBySha(orgId, SHA as never)
			assert.ok(Option.isSome(commit))
			assert.strictEqual(commit.value.authorLogin, "octocat")
			assert.strictEqual(commit.value.repositoryId, repoRow.value.id)
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	it.effect("raises VcsRepoDecodeError when a row has an invalid enum", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			// Resolving the service forces the Database layer (and the bundled schema
			// migration) to build, so the raw INSERT below hits an existing table.
			// Corrupt a row directly (account_type is not a valid VcsAccountType);
			// timestamps are real `timestamptz` values so only the enum decode fails.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO vcs_installations
						(id, org_id, provider, external_installation_id, account_login, account_type,
						 external_account_id, repository_selection, status, installed_by_user_id, created_at, updated_at)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())`,
					[
						randomUUID(),
						"org_x",
						"github",
						"55",
						"octo",
						"team",
						"1",
						"all",
						"active",
						"user_1",
					],
				),
			)
			const exit = yield* repo.resolveInstallation("github", "55").pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsRepoDecodeError)
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	it.effect(
		"purgeInstallation deletes the installation with its repos + commits, leaving other installations intact",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_purge")
				const repoFixture = (externalRepoId: string, fullName: string) => ({
					externalRepoId,
					owner: fullName.split("/")[0]!,
					name: fullName.split("/")[1]!,
					fullName,
					defaultBranch: "main",
					htmlUrl: `https://github.com/${fullName}`,
					isPrivate: true,
					isArchived: false,
				})
				const commitFixture = (sha: string) => ({
					sha,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/octo/repo/commit/${sha}`,
					branch: "main",
				})
				const seed = (
					externalInstallationId: string,
					accountLogin: string,
					externalAccountId: string,
				) =>
					repo.upsertInstallation({
						orgId,
						provider: "github",
						externalInstallationId,
						accountLogin,
						accountType: "organization",
						externalAccountId,
						accountAvatarUrl: null,
						repositorySelection: "all",
						installedByUserId: asUserId("user_1"),
					})

				// Two installations in the same org, each with a repo + a commit.
				yield* seed("42", "octo", "100")
				yield* seed("99", "other", "200")
				yield* upsertReposFor(repo, "42", [repoFixture("7", "octo/repo")])
				yield* upsertReposFor(repo, "99", [repoFixture("8", "other/repo")])
				const SHA_42 = "a".repeat(40)
				const SHA_99 = "b".repeat(40)
				yield* upsertCommitsFor(repo, orgId, "7", [commitFixture(SHA_42)])
				yield* upsertCommitsFor(repo, orgId, "8", [commitFixture(SHA_99)])

				yield* purgeInstallationFor(repo, orgId, "42")

				assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
				assert.strictEqual((yield* reposOfInstallation(repo, "42", "all")).length, 0)
				assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_42 as never)))

				// Installation 99 is untouched (delete was scoped to 42's repo ids).
				assert.ok(Option.isSome(yield* repo.resolveInstallation("github", "99")))
				assert.strictEqual((yield* reposOfInstallation(repo, "99", "all")).length, 1)
				assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_99 as never)))

				// Idempotent: purging again is a no-op, not an error.
				yield* purgeInstallationFor(repo, orgId, "42")
			}).pipe(Effect.provide(repoLayer(testDb)))
		},
	)

	const installationSeed = (externalInstallationId: string, externalAccountId: string) => ({
		provider: "github" as const,
		externalInstallationId,
		accountLogin: "octo",
		accountType: "organization" as const,
		externalAccountId,
		accountAvatarUrl: null,
		repositorySelection: "all" as const,
		installedByUserId: asUserId("user_1"),
	})

	const repoFixture = (over?: Partial<Parameters<VcsRepo["upsertRepositories"]>[1][number]>) => ({
		externalRepoId: "7",
		owner: "octo",
		name: "repo",
		fullName: "octo/repo",
		defaultBranch: "main",
		htmlUrl: "https://github.com/octo/repo",
		isPrivate: true,
		isArchived: false,
		...over,
	})

	// upsertRepositories' ON CONFLICT clause is the whole point of the upsert: a
	// re-listed repo must refresh its mutable metadata AND reactivate a prior
	// soft-removal, while leaving the user-owned trackedBranch untouched and never
	// duplicating the row.
	it.effect("re-upserting a repo refreshes metadata + reactivates it but preserves trackedBranch", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_conflict")
			yield* repo.upsertInstallation({ orgId, ...installationSeed("42", "100") })
			yield* upsertReposFor(repo, "42", [repoFixture()])
			const r = yield* repoFor(repo, orgId, "7")
			// The user picks a non-default tracked branch, then the provider revokes access.
			yield* repo.changeTrackedBranch(orgId, r.id, "feature")
			yield* repo.markRepositoryRemoved(r.id)
			// Access is re-granted and the repo has been renamed + made public upstream.
			yield* upsertReposFor(repo, "42", [
				repoFixture({ name: "repo-renamed", fullName: "octo/repo-renamed", isPrivate: false }),
			])

			const all = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(all.length, 1) // updated in place, never duplicated
			const updated = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(updated.status, "active") // soft-removal cleared
			assert.strictEqual(updated.name, "repo-renamed") // metadata refreshed
			assert.strictEqual(updated.isPrivate, false)
			assert.strictEqual(updated.trackedBranch, "feature") // the user's choice survives
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	// findCommitBySha is org-scoped: the same SHA legitimately exists in two orgs
	// (the unique key is (repositoryId, sha), not org-global). Each org must resolve
	// only its own row — a missing org filter would leak another tenant's commit.
	it.effect("findCommitBySha is org-scoped — the same SHA in two orgs never crosses over", () => {
		const testDb = createTestDb(trackedDbs)
		const SHARED = "a".repeat(40)
		const commitFixture = {
			sha: SHARED,
			message: "m",
			authorName: null,
			authorEmail: null,
			authorLogin: null,
			authorAvatarUrl: null,
			authoredAt: null,
			committedAt: 1,
			htmlUrl: `https://github.com/o/r/commit/${SHARED}`,
			branch: "main",
		}
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgA = asOrgId("org_a")
			const orgB = asOrgId("org_b")
			yield* repo.upsertInstallation({ orgId: orgA, ...installationSeed("42", "100") })
			yield* repo.upsertInstallation({ orgId: orgB, ...installationSeed("43", "200") })
			yield* upsertReposFor(repo, "42", [repoFixture({ externalRepoId: "7" })])
			yield* upsertReposFor(repo, "43", [repoFixture({ externalRepoId: "8" })])
			yield* upsertCommitsFor(repo, orgA, "7", [commitFixture])
			yield* upsertCommitsFor(repo, orgB, "8", [commitFixture])

			const repoA = yield* repoFor(repo, orgA, "7")
			const repoB = yield* repoFor(repo, orgB, "8")
			const foundA = yield* repo.findCommitBySha(orgA, SHARED as never)
			const foundB = yield* repo.findCommitBySha(orgB, SHARED as never)
			assert.strictEqual(expectSome(foundA).repositoryId, repoA.id)
			assert.strictEqual(expectSome(foundB).repositoryId, repoB.id)
			// And never the other org's row.
			assert.notStrictEqual(expectSome(foundA).repositoryId, repoB.id)
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	// changeTrackedBranch org-scopes BOTH the update and the commit-wipe. Calling it
	// with a foreign orgId for a real repo id must be a complete no-op — neither
	// retargeting the branch nor deleting that repo's commits (the over-delete guard
	// the inline comment warns about).
	it.effect("changeTrackedBranch with a foreign orgId neither retargets nor wipes commits", () => {
		const testDb = createTestDb(trackedDbs)
		const SHA_X = "a".repeat(40)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_owner")
			yield* repo.upsertInstallation({ orgId, ...installationSeed("42", "100") })
			yield* upsertReposFor(repo, "42", [repoFixture()])
			yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: SHA_X,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/o/r/commit/${SHA_X}`,
					branch: "main",
				},
			])
			const r = yield* repoFor(repo, orgId, "7")
			// Wrong org, real repo id.
			yield* repo.changeTrackedBranch(asOrgId("org_intruder"), r.id, "feature")

			const after = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(after.trackedBranch, "main") // untouched
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_X as never))) // not wiped
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	// "active" filters out provider-removed repos; "all" includes them.
	it.effect("listRepositoriesByInstallation 'active' excludes removed repos that 'all' includes", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_scope")
			yield* repo.upsertInstallation({ orgId, ...installationSeed("42", "100") })
			yield* upsertReposFor(repo, "42", [
				repoFixture({ externalRepoId: "7", fullName: "octo/a", name: "a" }),
				repoFixture({ externalRepoId: "8", fullName: "octo/b", name: "b" }),
			])
			yield* markRemovedFor(repo, orgId, "8")

			// Exercise the repo method directly (by internal installation id + scope).
			const inst = yield* installationFor(repo, "42")
			const active = yield* repo.listRepositoriesByInstallation(inst.id, "active")
			const all = yield* repo.listRepositoriesByInstallation(inst.id, "all")
			assert.deepStrictEqual(
				active.map((r) => r.externalRepoId),
				["7"],
			)
			assert.deepStrictEqual(all.map((r) => r.externalRepoId).sort(), ["7", "8"])
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	// A SHA persisted in any case is normalized to lowercase (the GitCommitSha decode
	// lowercases on the write path), so an uppercase push and a lowercase lookup never
	// split into two rows.
	it.effect("upsertCommits lowercases the SHA so a lowercase lookup finds an uppercased commit", () => {
		const testDb = createTestDb(trackedDbs)
		const UPPER = "A".repeat(40)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_lower")
			yield* repo.upsertInstallation({ orgId, ...installationSeed("42", "100") })
			yield* upsertReposFor(repo, "42", [repoFixture()])
			yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: UPPER,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/o/r/commit/${UPPER}`,
					branch: "main",
				},
			])
			// Stored lowercased → found by the lowercase form.
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, "a".repeat(40) as never)))
		}).pipe(Effect.provide(repoLayer(testDb)))
	})

	// Empty-input upserts are explicit early-out no-ops (not a malformed empty INSERT).
	it.effect(
		"empty upserts are no-ops: upsertCommits([]) returns 0, upsertBranches([]) does nothing",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_empty")
				yield* repo.upsertInstallation({ orgId, ...installationSeed("42", "100") })
				yield* upsertReposFor(repo, "42", [repoFixture()])
				const r = yield* repoFor(repo, orgId, "7")
				const count = yield* repo.upsertCommits(r, [])
				assert.strictEqual(count, 0)
				yield* repo.upsertBranches(r, [])
				assert.strictEqual((yield* repo.listBranchesByRepository(r.id)).length, 0)
			}).pipe(Effect.provide(repoLayer(testDb)))
		},
	)
})

describe("VcsSyncService orchestrator", () => {
	const SHA_A = "a".repeat(40)
	const SHA_B = "b".repeat(40)

	const commit = (sha: string, committedAt: number) => ({
		sha,
		message: `commit ${sha.slice(0, 7)}`,
		authorName: null,
		authorEmail: null,
		authorLogin: null,
		authorAvatarUrl: null,
		authoredAt: null,
		committedAt,
		htmlUrl: `https://github.com/o/r/commit/${sha}`,
		branch: "main",
	})

	interface StubOpts {
		readonly sent: Array<VcsSyncJob>
		readonly sentDelays?: Array<number | undefined>
		readonly repos?: ReadonlyArray<{
			externalRepoId: string
			owner: string
			name: string
			fullName: string
			defaultBranch: string
			htmlUrl: string
			isPrivate: boolean
			isArchived: boolean
		}>
		readonly commits?: ReadonlyArray<ReturnType<typeof commit>>
		readonly commitFetchNext?: {
			untilMs: number
			retryAfterSeconds: number
			reason: "rate-limited" | "page-budget"
		}
		readonly fetchCommitsError?: VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError
		readonly fetchReposError?: VcsRateLimitedError | VcsProviderError | VcsInstallationGoneError
		readonly branches?: ReadonlyArray<{ name: string; headSha: string | null }>
		readonly branchesTruncated?: boolean
		readonly fetchBranchesError?:
			| VcsProviderError
			| VcsInstallationGoneError
			| VcsRepoUnavailableError
			| VcsRateLimitedError
	}

	// Real VcsRepository (in-memory PGlite) + stubbed provider/queue ports, so
	// dispatch, cursor direction, and the drop guards are exercised against real
	// persistence.
	const orchestratorLayer = (testDb: TestDb, opts: StubOpts) => {
		const fakeProvider: VcsProviderClient = {
			id: "github",
			webhookToJobs: () => Effect.succeed([]),
			fetchRepositories: () =>
				opts.fetchReposError ? Effect.fail(opts.fetchReposError) : Effect.succeed(opts.repos ?? []),
			fetchCommits: () =>
				opts.fetchCommitsError
					? Effect.fail(opts.fetchCommitsError)
					: Effect.succeed({
							commits: opts.commits ?? [],
							...(opts.commitFetchNext ? { next: opts.commitFetchNext } : {}),
						}),
			fetchBranches: () =>
				opts.fetchBranchesError
					? Effect.fail(opts.fetchBranchesError)
					: Effect.succeed({
							branches: opts.branches ?? [],
							truncated: opts.branchesTruncated ?? false,
						}),
		}
		const registry = Layer.succeed(VcsProviderRegistry, {
			ids: ["github"],
			resolve: () => Effect.succeed(fakeProvider),
		} satisfies VcsProviderRegistryShape)
		const queue = recordingQueueLayer(opts.sent, { sentDelays: opts.sentDelays })
		const repoLive = testRepoLayer(testDb)
		return VcsSyncService.layer.pipe(Layer.provideMerge(Layer.mergeAll(repoLive, registry, queue)))
	}

	const seedInstallation = (repo: VcsRepo, orgId: ReturnType<typeof asOrgId>) =>
		repo.upsertInstallation({
			orgId,
			provider: "github",
			externalInstallationId: "42",
			accountLogin: "octo",
			accountType: "organization",
			externalAccountId: "100",
			accountAvatarUrl: null,
			repositorySelection: "all",
			installedByUserId: asUserId("user_1"),
		})

	const oneRepo = [
		{
			externalRepoId: "7",
			owner: "octo",
			name: "repo",
			fullName: "octo/repo",
			defaultBranch: "main",
			htmlUrl: "https://github.com/octo/repo",
			isPrivate: true,
			isArchived: false,
		},
	]

	it.effect("sync-branches reconciles branches and backfills only the single tracked branch", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(r.trackedBranch, "main")
			// Pre-seed a local "stale" branch (absent upstream) plus "release" (present upstream).
			yield* repo.upsertBranches(r, [
				{ name: "release", headSha: null },
				{ name: "stale", headSha: null },
			])

			const job: VcsSyncJob = {
				kind: "sync-branches",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// Remote = {main, release}: "stale" reconciled away, "main" added.
			const names = (yield* repo.listBranchesByRepository(r.id)).map((b) => b.name).sort()
			assert.deepStrictEqual(names, ["main", "release"])
			// Exactly one commit-sync, for the single tracked branch (the default "main").
			const synced = sent
				.filter((j) => j.kind === "sync-commits")
				.map((j) => (j.kind === "sync-commits" ? j.branch : ""))
			assert.deepStrictEqual(synced, ["main"])
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					branches: [
						{ name: "main", headSha: null },
						{ name: "release", headSha: null },
					],
				}),
			),
		)
	})

	it.effect("sync-branches keeps local branches when the provider listing was truncated", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")
			// A local branch that is absent from the (capped) remote listing.
			yield* repo.upsertBranches(r, [{ name: "kept", headSha: null }])

			const job: VcsSyncJob = {
				kind: "sync-branches",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// Truncated ⇒ absence isn't authoritative ⇒ the reconcile is skipped and
			// "kept" survives (a regression that dropped `truncated` would delete it).
			const names = (yield* repo.listBranchesByRepository(r.id)).map((b) => b.name).sort()
			assert.deepStrictEqual(names, ["kept", "main"])
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					branches: [{ name: "main", headSha: null }],
					branchesTruncated: true,
				}),
			),
		)
	})

	it.effect("sync-branches drains a repo-unavailable fetch without failing or enqueuing", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")
			// A branch that WOULD be re-listed if the sync ran to completion.
			yield* repo.upsertBranches(r, [{ name: "release", headSha: null }])

			const job: VcsSyncJob = {
				kind: "sync-branches",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
			}
			// fetchBranches fails repo-unavailable: the handler logs + drains, so
			// processMessage succeeds (no queue-retry storm). Reaching the assertions
			// below at all proves the error did not propagate.
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// Nothing reconciled and no backfill enqueued — the tracked branch is intact.
			assert.strictEqual(sent.length, 0)
			const names = (yield* repo.listBranchesByRepository(r.id)).map((b) => b.name).sort()
			assert.deepStrictEqual(names, ["release"])
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchBranchesError: new VcsRepoUnavailableError({ message: "repo gone" }),
				}),
			),
		)
	})

	it.effect("branch-event creates then deletes a branch (no queue work), keeping commits", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")

			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "branch-event",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					action: "created",
					branch: "feature/x",
				}),
			)
			assert.ok((yield* repo.listBranchesByRepository(r.id)).some((b) => b.name === "feature/x"))

			// Put a commit on the repo, then delete the branch — the commit row survives
			// (commits belong to the repo, not the deleted branch).
			yield* repo.upsertCommits(r, [commit(SHA_A, 1)])
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "branch-event",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					action: "deleted",
					branch: "feature/x",
				}),
			)
			assert.ok(!(yield* repo.listBranchesByRepository(r.id)).some((b) => b.name === "feature/x"))
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			assert.strictEqual(sent.length, 0) // branch events make no GitHub/queue calls
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: oneRepo })))
	})

	it.effect("deleting the tracked branch falls back to the default: wipes commits + resyncs", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")
			yield* repo.upsertBranches(r, [
				{ name: "main", headSha: null },
				{ name: "release", headSha: null },
			])
			yield* repo.changeTrackedBranch(orgId, r.id, "release")
			yield* repo.upsertCommits(r, [commit(SHA_A, 1)])
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))

			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "branch-event",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					action: "deleted",
					branch: "release",
				}),
			)

			// Tracked branch retargeted to the default, the old-branch commits wiped, and a
			// backfill of the default enqueued.
			const updated = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(updated.trackedBranch, "main")
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			const backfills = sent.filter((j) => j.kind === "sync-commits")
			assert.strictEqual(backfills.length, 1)
			assert.strictEqual(backfills[0]!.kind === "sync-commits" ? backfills[0]!.branch : "", "main")
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: oneRepo })))
	})

	it.effect("sync-branches retargets to the default when the tracked branch vanished upstream", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")
			yield* repo.upsertBranches(r, [
				{ name: "main", headSha: null },
				{ name: "release", headSha: null },
			])
			yield* repo.changeTrackedBranch(orgId, r.id, "release")
			yield* repo.upsertCommits(r, [commit(SHA_A, 1)])

			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "sync-branches",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
				}),
			)

			// Remote = {main} only ⇒ "release" (the tracked branch) reconciled away ⇒
			// retarget to "main": commits wiped, exactly one backfill, for "main".
			const updated = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(updated.trackedBranch, "main")
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			const backfills = sent.filter((j) => j.kind === "sync-commits")
			assert.strictEqual(backfills.length, 1)
			assert.strictEqual(backfills[0]!.kind === "sync-commits" ? backfills[0]!.branch : "", "main")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, { sent, repos: oneRepo, branches: [{ name: "main", headSha: null }] }),
			),
		)
	})

	it.effect("a forced push to the default branch enqueues a reconciling backfill", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "push",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					branch: "main",
					forced: true,
					commits: [commit(SHA_A, 1)],
				}),
			)
			const backfills = sent.filter((j) => j.kind === "sync-commits")
			assert.strictEqual(backfills.length, 1)
			assert.strictEqual(
				backfills[0]!.kind === "sync-commits" ? backfills[0]!.branch : undefined,
				"main",
			)
			// Forced ⇒ the payload is discarded (we re-walk instead), so SHA_A is not stored.
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: oneRepo })))
	})

	it.effect("drops a job for an unknown installation without persisting or failing", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			const job: VcsSyncJob = {
				kind: "push",
				provider: "github",
				externalInstallationId: "999", // never seeded
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)) // must not fail
			const found = yield* repo.findCommitBySha(orgId, SHA_A as never)
			assert.ok(Option.isNone(found))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	it.effect("push to an untracked non-default branch keeps the branch row but stores no commits", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			const r = yield* repoFor(repo, orgId, "7")
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "push",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					branch: "feature/x",
					commits: [commit(SHA_A, 1)],
				}),
			)
			// The branch is visible (so it can be tracked later) but is not the tracked one…
			const branches = yield* repo.listBranchesByRepository(r.id)
			assert.ok(branches.some((b) => b.name === "feature/x"))
			// …and its commits are NOT stored — only the tracked branch's commits are.
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	it.effect("push to a tracked non-default branch stores its commits", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			const r = yield* repoFor(repo, orgId, "7")
			yield* repo.upsertBranches(r, [{ name: "release", headSha: null }])
			yield* repo.changeTrackedBranch(orgId, r.id, "release")
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "push",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					branch: "release",
					commits: [commit(SHA_A, 1)],
				}),
			)
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	// A push is pure enrichment: it upserts commits but must NEVER move the repo's
	// sync_status (only the backfill owns that). Commit storage on the tracked branch
	// is covered by the tracked-push tests above; this pins the status invariant.
	it.effect("a push never changes repo sync state", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // a freshly-discovered repo (pending, no cursor)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "push",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					branch: "main",
					commits: [commit(SHA_A, 1)],
				}),
			)
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never))) // push landed…
			// …yet the sync status stays exactly as the backfill left it (untouched here).
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "pending")
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	it.effect("installation-sync upserts the provider's repos and enqueues a branch-sync per repo", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const repos = [
			{
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				fullName: "octo/repo",
				defaultBranch: "main",
				htmlUrl: "https://github.com/octo/repo",
				isPrivate: true,
				isArchived: false,
			},
		]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "created",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored.length, 1)
			assert.strictEqual(stored[0]!.externalRepoId, "7")
			// Per repo: only a branch-list sync. The commit backfills (default + tracked)
			// are enqueued later, when that sync-branches job is itself processed.
			assert.strictEqual(sent.length, 1)
			assert.strictEqual(sent.filter((j) => j.kind === "sync-branches").length, 1)
			assert.strictEqual(sent.filter((j) => j.kind === "sync-commits").length, 0)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos })))
	})

	// A new installation supersedes any prior one for the same org: the stale row and
	// its repos/commits are purged (guards against a missed `installation.deleted` webhook).
	it.effect("a 'created' installation-sync purges any prior installation for the org", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const repos = [
			{
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				fullName: "octo/repo",
				defaultBranch: "main",
				htmlUrl: "https://github.com/octo/repo",
				isPrivate: true,
				isArchived: false,
			},
		]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")

			yield* repo.upsertInstallation({
				orgId,
				provider: "github",
				externalInstallationId: "11",
				accountLogin: "old",
				accountType: "organization",
				externalAccountId: "1",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: asUserId("user_1"),
			})
			yield* upsertReposFor(repo, "11", [
				{
					externalRepoId: "70",
					owner: "old",
					name: "repo",
					fullName: "old/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/old/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const STALE_SHA = "c".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "70", [commit(STALE_SHA, 1)])

			yield* seedInstallation(repo, orgId)
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "created",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// The prior installation, its repos, and its commits are all hard-deleted…
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "11")))
			assert.strictEqual((yield* reposOfInstallation(repo, "11", "all")).length, 0)
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, STALE_SHA as never)))

			// …leaving exactly the new installation, which synced its own repo.
			const remaining = (yield* repo.listInstallationsByOrg(orgId)).filter(
				(i) => i.provider === "github",
			)
			assert.strictEqual(remaining.length, 1)
			assert.strictEqual(remaining[0]!.externalInstallationId, "42")
			const newRepos = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(newRepos.length, 1)
			assert.strictEqual(newRepos[0]!.externalRepoId, "7")
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos })))
	})

	it.effect("backfill persists fetched commits and marks the repo ready", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const commits = [commit(SHA_A, 1), commit(SHA_B, 2)]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const job: VcsSyncJob = {
				kind: "sync-commits",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				branch: "main",
				sinceMs: 0,
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const a = yield* repo.findCommitBySha(orgId, SHA_A as never)
			const b = yield* repo.findCommitBySha(orgId, SHA_B as never)
			assert.ok(Option.isSome(a) && Option.isSome(b))
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "ready")
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, commits })))
	})

	const seedRepo = (repo: VcsRepo) =>
		upsertReposFor(repo, "42", [
			{
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				fullName: "octo/repo",
				defaultBranch: "main",
				htmlUrl: "https://github.com/octo/repo",
				isPrivate: true,
				isArchived: false,
			},
		])

	const backfillJob: VcsSyncJob = {
		kind: "sync-commits",
		provider: "github",
		externalInstallationId: "42",
		externalRepoId: "7",
		owner: "octo",
		name: "repo",
		branch: "main",
		sinceMs: 0,
	}

	it.effect("VcsRepoUnavailableError marks the repo errored and leaves the installation active", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			// A repo-scoped error must NOT fail the job (it drains).
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob))
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "active") // never disconnected
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "error")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchCommitsError: new VcsRepoUnavailableError({ message: "repo gone" }),
				}),
			),
		)
	})

	it.effect("VcsInstallationGoneError disconnects the installation and drains the job", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // backfill is gated on the repo row existing
			// The provider's authoritative gone signal → disconnect, no failure.
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob))
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "disconnected")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchCommitsError: new VcsInstallationGoneError({ message: "installation gone" }),
				}),
			),
		)
	})

	it.effect("transient VcsProviderError fails the job so the queue retries, installation untouched", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // backfill is gated on the repo row existing
			const exit = yield* svc
				.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob))
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit)) // transient → propagated so the queue retries
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "active")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchCommitsError: new VcsProviderError({ message: "upstream unavailable", status: 503 }),
				}),
			),
		)
	})

	// Processability gate: a non-active installation must process nothing.
	it.effect("a suspended installation is skipped — no data processed, no failure", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* markInstStatusFor(repo, "42", "suspended")
			const job: VcsSyncJob = {
				kind: "push",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)) // gated → must not fail
			const a = yield* repo.findCommitBySha(orgId, SHA_A as never)
			assert.ok(Option.isNone(a)) // gate short-circuits before the upsert
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "suspended") // status untouched
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, commits: [commit(SHA_A, 1)] })))
	})

	it.effect("unsuspend reactivates a suspended installation and re-syncs its repos", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const repos = [
			{
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				fullName: "octo/repo",
				defaultBranch: "main",
				htmlUrl: "https://github.com/octo/repo",
				isPrivate: true,
				isArchived: false,
			},
		]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* markInstStatusFor(repo, "42", "suspended")
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "unsuspend",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "active") // reactivated — the unique behavior here
			// And the reactivation triggers a fresh re-sync (repos stored + work enqueued).
			// The exact enqueue shape is the installation-sync test's job, not re-asserted here.
			assert.strictEqual((yield* reposOfInstallation(repo, "42", "all")).length, 1)
			assert.strictEqual(sent.length, 1)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos })))
	})

	// A rate-limited backfill checkpoints + requeues a delayed continuation rather
	// than failing — no retry budget spent, finished pages not refetched.
	it.effect("a rate-limited backfill requeues a continuation with a cursor + delay", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const sentDelays: Array<number | undefined> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob)) // must not fail
			// The fetched commit was persisted…
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			// …the repo is marked backfilling (in progress, not ready)…
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "backfilling")
			// …and a continuation was requeued from the watermark, delayed until reset.
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "sync-commits")
			if (continuation.kind !== "sync-commits") return
			assert.strictEqual(continuation.untilMs, 5000)
			assert.strictEqual(sentDelays[0], 600)
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					sentDelays,
					commits: [commit(SHA_A, 1)],
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 600, reason: "rate-limited" },
				}),
			),
		)
	})

	// A page-budget continuation (the walk yielded to stay under the queue's 15-min
	// limit, NOT throttled) checkpoints and requeues to continue *immediately*.
	it.effect("a page-budget backfill requeues a continuation with no delay", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const sentDelays: Array<number | undefined> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob)) // must not fail
			// The fetched page was persisted and the repo marked backfilling…
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "backfilling")
			// …and a continuation was requeued from the watermark with NO delay…
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "sync-commits")
			if (continuation.kind !== "sync-commits") return
			assert.strictEqual(continuation.untilMs, 5000)
			assert.strictEqual(sentDelays[0], 0)
			// …and it never counts against the stall cap (it made progress).
			assert.strictEqual(continuation.staleAttempts, 0)
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					sentDelays,
					commits: [commit(SHA_A, 1)],
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 0, reason: "page-budget" },
				}),
			),
		)
	})

	// A backfill that keeps getting rate-limited *before any commit* must not
	// requeue forever — after the stall cap it errors the repo instead.
	it.effect("a backfill with no progress stops after the stall cap", () => {
		const STALL_CAP = MAX_BACKFILL_STALL_RETRIES
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			// Drive the continuation back through the consumer; every run fetches zero
			// commits (still throttled), so the watermark never moves.
			let job: VcsSyncJob = backfillJob
			for (let i = 0; i <= STALL_CAP; i++) {
				yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))
				if (sent.length > 0) job = sent[sent.length - 1]!
			}
			// It requeued exactly the cap's worth of continuations, then gave up.
			assert.strictEqual(sent.length, STALL_CAP)
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "error")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					commits: [], // zero progress on every run
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 600, reason: "rate-limited" },
				}),
			),
		)
	})

	// A rate-limited installation-sync isn't resumable — it propagates so the
	// consumer redelivers the whole (small) job after the delay.
	it.effect("a rate-limited installation-sync propagates VcsRateLimitedError", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "created",
			}
			const exit = yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			const error = findError(exit)
			assert.ok(error instanceof VcsRateLimitedError)
			assert.strictEqual((error as VcsRateLimitedError).retryAfterSeconds, 600)
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchReposError: new VcsRateLimitedError({
						message: "rate limited",
						retryAfterSeconds: 600,
					}),
				}),
			),
		)
	})

	// A repositories_removed sync soft-deletes repos no longer visible upstream:
	// the row + its commits are kept (status → "removed", excluded from "active"),
	// so history survives and a later re-grant can reactivate it.
	it.effect("repositories_removed soft-deletes a vanished repo and keeps its commits", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // repo "7", active
			yield* upsertCommitsFor(repo, orgId, "7", [commit(SHA_A, 1)])

			// Upstream no longer lists repo "7" (fetchRepositories stubbed to []).
			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "repositories_removed",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			// Row kept but marked removed: excluded from "active", present in "all".
			const active = yield* reposOfInstallation(repo, "42", "active")
			assert.strictEqual(active.length, 0)
			const all = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(all.length, 1)
			assert.strictEqual(all[0]!.status, "removed")
			// Its commits are retained (soft delete, not a purge).
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: [] })))
	})

	// Re-granting access (the repo reappears in a later sync) reactivates the
	// soft-deleted row via upsertRepositories.
	it.effect("a re-added repo is reactivated (status back to active)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const repos = [
			{
				externalRepoId: "7",
				owner: "octo",
				name: "repo",
				fullName: "octo/repo",
				defaultBranch: "main",
				htmlUrl: "https://github.com/octo/repo",
				isPrivate: true,
				isArchived: false,
			},
		]
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* markRemovedFor(repo, orgId, "7") // provider had removed it

			const job: VcsSyncJob = {
				kind: "installation-sync",
				provider: "github",
				externalInstallationId: "42",
				reason: "repositories_added",
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job))

			const all = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(all.length, 1)
			assert.strictEqual(all[0]!.status, "active") // reactivated
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos })))
	})

	// A push to a soft-removed repo is paused — the commit is not written, even
	// though the repo row still exists.
	it.effect("a push to a removed repo is skipped", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* markRemovedFor(repo, orgId, "7")

			const job: VcsSyncJob = {
				kind: "push",
				provider: "github",
				externalInstallationId: "42",
				externalRepoId: "7",
				branch: "main",
				commits: [commit(SHA_A, 1)],
			}
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(job)) // must not fail
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	// The enqueued backfill must walk from `now - BACKFILL_WINDOW_MS`, not from `now`
	// (which would fetch zero history) — a sign/offset regression here is silent: the
	// job still enqueues with the right branch, it just never imports any commits.
	it.effect("an enqueued backfill walks from now − BACKFILL_WINDOW_MS (fresh, no cursor)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const before = yield* Clock.currentTimeMillis
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "sync-branches",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
				}),
			)
			const after = yield* Clock.currentTimeMillis
			const backfill = sent.find((j) => j.kind === "sync-commits")
			assert.ok(backfill && backfill.kind === "sync-commits")
			if (!backfill || backfill.kind !== "sync-commits") return
			// A fresh walk starts from the tip (no resume cursor)…
			assert.strictEqual(backfill.untilMs, undefined)
			// …and reaches back exactly one window from the enqueue moment.
			assert.ok(backfill.sinceMs >= before - BACKFILL_WINDOW_MS)
			assert.ok(backfill.sinceMs <= after - BACKFILL_WINDOW_MS)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, branches: [{ name: "main", headSha: null }] })))
	})

	// A continuation must carry the original walk's `sinceMs` (and branch) unchanged —
	// only `untilMs`/`staleAttempts` advance. Resetting `sinceMs` per page re-expands
	// the window every continuation, so the walk never terminates.
	it.effect("a backfill continuation preserves sinceMs + branch, advancing only untilMs", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)(backfillJob))
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "sync-commits")
			if (continuation.kind !== "sync-commits") return
			assert.strictEqual(continuation.sinceMs, backfillJob.sinceMs) // carried through (0)
			assert.strictEqual(continuation.branch, "main")
			assert.strictEqual(continuation.externalRepoId, "7")
			assert.strictEqual(continuation.untilMs, 5000) // only the watermark moves
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					commits: [commit(SHA_A, 1)],
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 0, reason: "page-budget" },
				}),
			),
		)
	})

	// A no-progress continuation must INCREMENT staleAttempts (the stall cap is
	// otherwise unreachable and the requeue loop never terminates).
	it.effect("a no-progress backfill increments staleAttempts on the continuation", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)({ ...backfillJob, staleAttempts: 3 }))
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "sync-commits")
			if (continuation.kind !== "sync-commits") return
			assert.strictEqual(continuation.staleAttempts, 4) // 3 + 1, zero commits fetched
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					commits: [], // no progress
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 600, reason: "rate-limited" },
				}),
			),
		)
	})

	// Any productive run resets the stall counter — so an installation that recovers
	// after several throttled runs gets the full stall budget again.
	it.effect("a productive backfill resets staleAttempts to 0 on the continuation", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			// Carry a high stale count in, and make progress (commits fetched + watermark
			// moved below the prior boundary) so neither stall guard fires.
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({ ...backfillJob, untilMs: 10000, staleAttempts: 5 }),
			)
			assert.strictEqual(sent.length, 1)
			const continuation = sent[0]!
			assert.strictEqual(continuation.kind, "sync-commits")
			if (continuation.kind !== "sync-commits") return
			assert.strictEqual(continuation.staleAttempts, 0)
			assert.strictEqual(continuation.untilMs, 5000)
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					commits: [commit(SHA_A, 1)],
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 0, reason: "page-budget" },
				}),
			),
		)
	})

	// A resume that fetched commits but didn't move the watermark below its boundary
	// (e.g. >100 commits sharing one committer-second) would requeue forever. The guard
	// stops + errors instead — distinct from the rate-limit stall cap.
	it.effect("a backfill whose watermark fails to advance errors the repo (no requeue)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			// Resume from untilMs=5000; the page comes back with commits but next.untilMs
			// is NOT below 5000 → no progress past the boundary.
			yield* svc.processMessage(Schema.encodeSync(VcsSyncJob)({ ...backfillJob, untilMs: 5000 }))
			assert.strictEqual(sent.length, 0) // never requeues
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "error")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					commits: [commit(SHA_A, 1)], // fetched, but…
					commitFetchNext: { untilMs: 5000, retryAfterSeconds: 0, reason: "page-budget" }, // …watermark stuck at 5000
				}),
			),
		)
	})

	// fetchBranches errors are NOT all drained: only repo-unavailable is swallowed
	// (covered above). A transient provider error must propagate so the queue retries.
	it.effect("sync-branches propagates a transient VcsProviderError (queue retries)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const exit = yield* svc
				.processMessage(
					Schema.encodeSync(VcsSyncJob)({
						kind: "sync-branches",
						provider: "github",
						externalInstallationId: "42",
						externalRepoId: "7",
						owner: "octo",
						name: "repo",
					}),
				)
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.strictEqual(sent.length, 0)
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchBranchesError: new VcsProviderError({ message: "upstream", status: 503 }),
				}),
			),
		)
	})

	// A rate-limited branch sync has no resume cursor, so it propagates (the consumer
	// redelivers the whole small job) rather than being silently swallowed.
	it.effect("sync-branches propagates a VcsRateLimitedError (not swallowed)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const exit = yield* svc
				.processMessage(
					Schema.encodeSync(VcsSyncJob)({
						kind: "sync-branches",
						provider: "github",
						externalInstallationId: "42",
						externalRepoId: "7",
						owner: "octo",
						name: "repo",
					}),
				)
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsRateLimitedError)
			assert.strictEqual(sent.length, 0)
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchBranchesError: new VcsRateLimitedError({
						message: "rate limited",
						retryAfterSeconds: 600,
					}),
				}),
			),
		)
	})

	// An installation-gone signal from the branch path routes through the same
	// disconnect handler as the commit path.
	it.effect("sync-branches reporting installation-gone disconnects the installation", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "sync-branches",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
				}),
			)
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "disconnected")
		}).pipe(
			Effect.provide(
				orchestratorLayer(testDb, {
					sent,
					fetchBranchesError: new VcsInstallationGoneError({ message: "gone" }),
				}),
			),
		)
	})

	// A push to the tracked branch when no branch row exists yet must BOTH create the
	// picker row (getOrCreateBranch precedes the tracked check) and store the commits.
	it.effect("push to the tracked branch with no branch row creates the row and stores commits", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo) // repo only — no branch rows yet
			const r = yield* repoFor(repo, orgId, "7")
			assert.strictEqual((yield* repo.listBranchesByRepository(r.id)).length, 0)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "push",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					branch: "main", // the default → tracked
					commits: [commit(SHA_A, 1)],
				}),
			)
			assert.ok((yield* repo.listBranchesByRepository(r.id)).some((b) => b.name === "main"))
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, SHA_A as never)))
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	// A branch-pointer move / no-new-commits merge: a tracked push with an empty commit
	// list is a no-op upsert, must not fail, and must not touch sync state.
	it.effect("an empty-commits push to the tracked branch is a no-op (status untouched)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* seedRepo(repo)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "push",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					branch: "main",
					commits: [],
				}),
			) // must not fail
			const stored = yield* reposOfInstallation(repo, "42", "all")
			assert.strictEqual(stored[0]!.syncStatus, "pending") // a push never moves sync state
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})

	// A "suspend" installation-sync only flips the gate's answer — it must NOT call the
	// provider or enqueue any work (a regression that fell through would re-sync a
	// suspended installation).
	it.effect("installation-sync 'suspend' marks suspended without syncing", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "installation-sync",
					provider: "github",
					externalInstallationId: "42",
					reason: "suspend",
				}),
			)
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "suspended")
			assert.strictEqual(sent.length, 0) // no fetchRepositories, no branch-sync enqueued
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: oneRepo })))
	})

	// A "deleted" installation-sync disconnects without syncing.
	it.effect("installation-sync 'deleted' marks disconnected without syncing", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "installation-sync",
					provider: "github",
					externalInstallationId: "42",
					reason: "deleted",
				}),
			)
			const inst = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(inst))
			assert.strictEqual(inst.value.status, "disconnected")
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: oneRepo })))
	})

	// Reconnecting (the dashboard's "Reconnect" flow re-enqueues "updated" for an
	// existing org's external id, or "created" for a brand-new install) must revive a
	// disconnected row, not leave it gated out. upsertInstallation leaves status
	// untouched on conflict, so the sync engine is what flips it back to active —
	// proving the reconnect actually resumes syncing. Both reactivating reasons share
	// one code path, so they're exercised in a table to keep them honest.
	for (const reason of ["updated", "created"] as const) {
		it.effect(
			`installation-sync '${reason}' reactivates a disconnected installation and re-syncs`,
			() => {
				const testDb = createTestDb(trackedDbs)
				const sent: Array<VcsSyncJob> = []
				return Effect.gen(function* () {
					const svc = yield* VcsSyncService
					const repo = yield* VcsRepository
					const orgId = asOrgId("org_orch")
					yield* seedInstallation(repo, orgId)
					yield* markInstStatusFor(repo, "42", "disconnected")
					yield* svc.processMessage(
						Schema.encodeSync(VcsSyncJob)({
							kind: "installation-sync",
							provider: "github",
							externalInstallationId: "42",
							reason,
						}),
					)
					const inst = yield* repo.resolveInstallation("github", "42")
					assert.ok(Option.isSome(inst))
					assert.strictEqual(inst.value.status, "active") // revived — was disconnected
					// Reactivation runs the full sync: the repo is stored and branch-sync enqueued.
					assert.strictEqual((yield* reposOfInstallation(repo, "42", "all")).length, 1)
					assert.strictEqual(sent.length, 1)
				}).pipe(Effect.provide(orchestratorLayer(testDb, { sent, repos: oneRepo })))
			},
		)
	}

	// Deleting a branch that has no local row is a reported no-op: no failure, no queue
	// work, and crucially no retarget even if the (absent) name equals the tracked one.
	it.effect("branch-event delete of an absent branch is a no-op (no retarget)", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsSyncService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_orch")
			yield* seedInstallation(repo, orgId)
			yield* upsertReposFor(repo, "42", oneRepo)
			const r = yield* repoFor(repo, orgId, "7")
			yield* repo.upsertBranches(r, [{ name: "main", headSha: null }])
			yield* repo.changeTrackedBranch(orgId, r.id, "release") // tracked branch never had a row
			yield* svc.processMessage(
				Schema.encodeSync(VcsSyncJob)({
					kind: "branch-event",
					provider: "github",
					externalInstallationId: "42",
					externalRepoId: "7",
					action: "deleted",
					branch: "release", // == tracked, but no row exists → deleteBranch returns false
				}),
			)
			// deleteBranch returned false → the retarget branch is skipped: tracked unchanged.
			const updated = yield* repoFor(repo, orgId, "7")
			assert.strictEqual(updated.trackedBranch, "release")
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(orchestratorLayer(testDb, { sent })))
	})
})

// The SHA-shape regex lives only in the GitCommitSha brand; these assert that
// validation fires at both the webhook decode boundary and on persistence.
describe("git SHA validation (branded type)", () => {
	it("GitCommitSha accepts mixed-case input and normalizes it to lowercase", () => {
		const decode = Schema.decodeUnknownSync(GitCommitSha)
		// All-uppercase 40-hex is accepted and lowercased.
		assert.strictEqual(decode("A".repeat(40)), "a".repeat(40))
		// Mixed case round-trips to its lowercase form (so case never splits a row).
		const mixed = "AbCdEf0123456789aBcDeF0123456789AbCdEf01"
		assert.strictEqual(decode(mixed), mixed.toLowerCase())
		// Non-hex / wrong length are still rejected (after lowercasing).
		assert.throws(() => decode("Z".repeat(40)))
		assert.throws(() => decode("abc"))
	})

	it.effect("webhook decode rejects a malformed commit SHA with VcsWebhookParseError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const body = JSON.stringify({
				ref: "refs/heads/main",
				repository: { id: 7, owner: { login: "octo" } },
				installation: { id: 42 },
				after: SHA, // valid head, so the parse failure is specifically the commit id
				commits: [{ id: "not-a-real-sha", message: "x", url: "https://example.com" }],
			})
			const exit = yield* provider
				.webhookToJobs({
					headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
					rawBody: body,
				})
				.pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			assert.ok(findError(exit) instanceof VcsWebhookParseError)
		}).pipe(Effect.provide(providerLayer())),
	)

	it.effect("upsertCommits rejects a malformed SHA with VcsRepoDecodeError", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_sha")
			// Seed an installation + repo so the commit attaches to a real repo entity
			// (the repo service decodes the SHA while building the row).
			yield* repo.upsertInstallation({
				orgId,
				provider: "github",
				externalInstallationId: "42",
				accountLogin: "octo",
				accountType: "organization",
				externalAccountId: "100",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: asUserId("user_1"),
			})
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const exit = yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: "ABC", // not 40-char hex (case-insensitive, but still invalid)
					message: "bad",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: "https://example.com",
					branch: "main",
				},
			]).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			const error = findError(exit)
			assert.ok(error instanceof VcsRepoDecodeError)
			// The write-side decode pins the offending column so a row-build failure is
			// distinguishable from a read-side row decode (which carries no column).
			assert.strictEqual((error as VcsRepoDecodeError).column, "sha")
		}).pipe(Effect.provide(repoLayer(testDb)))
	})
})

// The centralized GitHub fetch detects 429s and decides: ride out short waits
// inline; surface long ones (backfill → partial `next`; repos → VcsRateLimitedError).
describe("GithubProvider rate-limit handling", () => {
	const REPO = { externalRepoId: "7", owner: "octo", name: "repo" }
	const installation = Schema.decodeUnknownSync(VcsInstallation)({
		id: randomUUID(),
		orgId: "org_test",
		provider: "github",
		externalInstallationId: "123456",
		accountLogin: "octo",
		accountType: "organization",
		externalAccountId: "1",
		accountAvatarUrl: null,
		repositorySelection: "all",
		status: "active",
		suspendedAt: null,
		installedByUserId: "user_1",
		createdAt: 0,
		updatedAt: 0,
	})

	it.effect("rides out a short rate limit inline, then completes", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0, branch: "main" })
			assert.strictEqual(result.commits.length, 1)
			assert.strictEqual(result.next, undefined) // retried past the 429 → window complete
		}).pipe(
			// token mint → page 1 (429, retry-after 0 → inline retry) → page 1 (commits)
			Effect.provide(
				stubbedProviderLayer([
					tokenResponse,
					() => rateLimited(0),
					() => commitsResponse(["a".repeat(40)]),
				]),
			),
		),
	)

	it.effect("surfaces a long rate limit mid-walk as a partial result with `next`", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0, branch: "main" })
			assert.strictEqual(result.commits.length, 100) // page 1 kept, not thrown away
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.retryAfterSeconds, 600)
		}).pipe(
			// token → page 1 (full) → page 2 (429, retry-after 600 → defer)
			Effect.provide(
				stubbedProviderLayer([
					tokenResponse,
					() => commitsResponse(hexShas(100)),
					() => rateLimited(600),
				]),
			),
		),
	)

	it.effect("a long rate limit on fetchRepositories raises VcsRateLimitedError", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* provider.fetchRepositories(installation).pipe(Effect.exit)
			assert.ok(Exit.isFailure(exit))
			const error = findError(exit)
			assert.ok(error instanceof VcsRateLimitedError)
			assert.strictEqual((error as VcsRateLimitedError).retryAfterSeconds, 600)
		}).pipe(
			// token → repos page 1 (429, retry-after 600 → surfaced, not resumable)
			Effect.provide(stubbedProviderLayer([tokenResponse, () => rateLimited(600)])),
		),
	)

	it.effect("stops riding out a rate limit after the inline-retry cap and defers", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			// Every page replies with a 0s-wait 429; without a retry cap this would spin
			// forever. The cap surfaces it as a deferral instead, floored off 0.
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0, branch: "main" })
			assert.strictEqual(result.commits.length, 0)
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.retryAfterSeconds, 60)
		}).pipe(
			// token → page 1 (429 retry-after 0, repeated past the inline cap)
			Effect.provide(stubbedProviderLayer([tokenResponse, () => rateLimited(0)])),
		),
	)

	// Not throttled — the walk voluntarily yields after the per-invocation page
	// budget so one consumer invocation can't approach the Queues 15-min limit.
	it.effect("yields a page-budget continuation when the per-invocation page cap is hit", () =>
		Effect.gen(function* () {
			// Every page comes back full (100), so the pager never sees a short page and
			// stops only at COMMIT_PAGES_PER_INVOCATION, handing back a continuation
			// instead of walking everything.
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0, branch: "main" })
			assert.strictEqual(result.commits.length, COMMIT_PAGES_PER_INVOCATION * 100)
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.reason, "page-budget")
			assert.strictEqual(result.next?.retryAfterSeconds, 0) // continue immediately, no wait
		}).pipe(
			// token → full page on every fetch (the last responder repeats for all
			// subsequent pages), so the only stop condition is the page budget.
			Effect.provide(stubbedProviderLayer([tokenResponse, () => commitsResponse(hexShas(100))])),
		),
	)

	// GitHub may send `retry-after` as an HTTP-date instead of delta-seconds; the wait
	// is the seconds until that instant. A long date-based wait defers (no inline sleep).
	// (Computed against the Effect clock, which the test runtime pins at epoch 0, so the
	// date is expressed as an offset from the epoch — keeping the delta exact.)
	it.effect("computes the deferral from an HTTP-date retry-after header", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0, branch: "main" })
			assert.strictEqual(result.commits.length, 0)
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.retryAfterSeconds, 600) // 600s past the epoch clock
		}).pipe(
			Effect.provide(
				stubbedProviderLayer([
					tokenResponse,
					() =>
						new Response("rate limited", {
							status: 429,
							headers: { "retry-after": new Date(600_000).toUTCString() },
						}),
				]),
			),
		),
	)

	// With no `retry-after`, the wait falls back to `x-ratelimit-reset` (epoch seconds).
	it.effect("falls back to x-ratelimit-reset (epoch seconds) when retry-after is absent", () =>
		Effect.gen(function* () {
			const provider = yield* GithubProvider
			const result = yield* provider.fetchCommits(installation, REPO, { sinceMs: 0, branch: "main" })
			assert.strictEqual(result.commits.length, 0)
			assert.ok(result.next !== undefined)
			assert.strictEqual(result.next?.retryAfterSeconds, 600) // reset is 600s past the epoch clock
		}).pipe(
			Effect.provide(
				stubbedProviderLayer([
					tokenResponse,
					() =>
						new Response("rate limited", {
							status: 429,
							headers: { "x-ratelimit-reset": "600" },
						}),
				]),
			),
		),
	)
})

// The queue producer floors + clamps every requested delay into the range the
// Cloudflare binding accepts ([0, 86_400] whole seconds); an out-of-range or
// fractional value would otherwise make the live `send` reject outright. The
// rate-limit continuation feeds `retryAfterSeconds` straight through this.
describe("clampQueueDelaySeconds", () => {
	it("floors fractional seconds", () => {
		assert.strictEqual(clampQueueDelaySeconds(600.7), 600)
		assert.strictEqual(clampQueueDelaySeconds(0.9), 0)
	})
	it("clamps below 0 up to 0", () => {
		assert.strictEqual(clampQueueDelaySeconds(-5), 0)
	})
	it("caps at the 24h maximum", () => {
		assert.strictEqual(clampQueueDelaySeconds(90_000), 86_400)
		assert.strictEqual(clampQueueDelaySeconds(86_400), 86_400)
	})
	it("passes an in-range whole number through unchanged", () => {
		assert.strictEqual(clampQueueDelaySeconds(600), 600)
		assert.strictEqual(clampQueueDelaySeconds(0), 0)
	})
})
