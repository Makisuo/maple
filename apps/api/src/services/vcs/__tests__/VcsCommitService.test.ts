import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	IntegrationsNotConnectedError,
	type OrgId,
	VcsCommitNotFoundError,
	VcsCommitShaInvalidError,
} from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/lib/test-pglite"
import { GithubAppClient } from "@/services/vcs/vendor/github/GithubAppClient"
import { GithubHttp, type GithubHttpShape } from "@/services/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "@/services/vcs/vendor/github/GithubProvider"
import { VcsCommitService } from "@/services/vcs/VcsCommitService"
import { VcsProviderRegistry } from "@/services/vcs/VcsProviderRegistry"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import {
	asOrgId,
	asUserId,
	expectSome,
	findError,
	GITHUB_APP_CONFIG,
	jsonResponse,
	testEnv,
	type VcsRepo,
} from "./harness"
import { decodeGitCommitSha } from "./fixtures"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const commitBody = (sha: string) => ({
	sha,
	html_url: `https://github.com/octo/repo/commit/${sha}`,
	commit: {
		message: "Fix the thing\n\nlonger body",
		author: { name: "Octo Cat", email: "octo@example.com", date: "2026-06-01T00:00:00Z" },
		committer: { name: "Octo Cat", email: "octo@example.com", date: "2026-06-02T00:00:00Z" },
	},
	author: { login: "octocat", avatar_url: "https://avatars/u/1" },
})

// GithubHttp seam: access-token POSTs always succeed; commit GETs return the canned
// body or 404 based on `resolvable`. Counts GETs so tests can verify the negative cache.
const routedHttp = (resolvable: (repoName: string, sha: string) => boolean) => {
	const calls = { commitGets: 0 }
	const layer = Layer.succeed(GithubHttp, {
		fetch: async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			const method = init?.method ?? "GET"
			if (url.includes("/access_tokens") && method === "POST") {
				return jsonResponse({ token: "ghs_test", expires_at: "2999-01-01T00:00:00Z" })
			}
			const match = url.match(/\/repos\/[^/]+\/([^/]+)\/commits\/([0-9a-fA-F]+)/)
			if (match) {
				calls.commitGets += 1
				const [, repoName, sha] = match
				return resolvable(repoName!, sha!.toLowerCase())
					? jsonResponse(commitBody(sha!.toLowerCase()))
					: jsonResponse({ message: "No commit found for SHA" }, { status: 404 })
			}
			return jsonResponse({ message: `unexpected ${method} ${url}` }, { status: 500 })
		},
	} satisfies GithubHttpShape)
	return { layer, calls }
}

// Full layer stack over an in-memory PGlite + stubbed GithubHttp. `data` appears in
// both the service deps and the returned merge so Effect memoizes one shared repo
// instance.
const commitLayer = (testDb: TestDb, http: Layer.Layer<GithubHttp>) => {
	const env = testEnv(GITHUB_APP_CONFIG)
	const data = VcsRepository.layer.pipe(Layer.provide(testDb.layer), Layer.provide(env))
	const githubAppClient = GithubAppClient.layer.pipe(Layer.provide(http), Layer.provide(env))
	const provider = GithubProvider.layer.pipe(Layer.provide(Layer.mergeAll(env, githubAppClient)))
	const registry = VcsProviderRegistry.layer.pipe(Layer.provide(provider))
	const service = VcsCommitService.layer.pipe(Layer.provide(Layer.mergeAll(data, registry)))
	return Layer.mergeAll(service, data)
}

// Seed an active installation ("42") and its repos directly via the repo layer.
const seed = (repo: VcsRepo, orgId: OrgId, repos: ReadonlyArray<{ externalRepoId: string; name: string }>) =>
	Effect.gen(function* () {
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
		const inst = expectSome(yield* repo.resolveInstallation("github", "42"))
		yield* repo.upsertRepositories(
			inst,
			repos.map((r) => ({
				externalRepoId: r.externalRepoId,
				owner: "octo",
				name: r.name,
				fullName: `octo/${r.name}`,
				defaultBranch: "main",
				htmlUrl: `https://github.com/octo/${r.name}`,
				isPrivate: false,
				isArchived: false,
			})),
		)
	})

describe("VcsCommitService.resolveCommitDetail", () => {
	it.effect("returns a stored commit without calling the provider", () => {
		const testDb = createTestDb(trackedDbs)
		const { layer, calls } = routedHttp(() => false)
		const SHA = "a".repeat(40)
		return Effect.gen(function* () {
			const svc = yield* VcsCommitService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			yield* seed(repo, orgId, [{ externalRepoId: "7", name: "repo" }])
			const r = expectSome(yield* repo.resolveRepository(orgId, "github", "7"))
			yield* repo.upsertCommits(r, [
				{
					sha: SHA,
					message: "stored message",
					authorName: "Stored Author",
					authorEmail: "s@example.com",
					authorLogin: "storedlogin",
					authorAvatarUrl: null,
					authoredAt: 1000,
					committedAt: 2000,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
				},
			])

			const detail = yield* svc.resolveCommitDetail(orgId, SHA)
			assert.strictEqual(detail.resolved, "stored")
			assert.strictEqual(detail.sha, SHA)
			assert.strictEqual(detail.message, "stored message")
			assert.strictEqual(detail.repoFullName, "octo/repo")
			assert.strictEqual(calls.commitGets, 0)
		}).pipe(Effect.provide(commitLayer(testDb, layer)))
	})

	it.effect("uppercase SHA resolves the same stored commit (normalized)", () => {
		const testDb = createTestDb(trackedDbs)
		const { layer } = routedHttp(() => false)
		const SHA = "a".repeat(40)
		return Effect.gen(function* () {
			const svc = yield* VcsCommitService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			yield* seed(repo, orgId, [{ externalRepoId: "7", name: "repo" }])
			const r = expectSome(yield* repo.resolveRepository(orgId, "github", "7"))
			yield* repo.upsertCommits(r, [
				{
					sha: SHA,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
				},
			])
			const detail = yield* svc.resolveCommitDetail(orgId, "A".repeat(40))
			assert.strictEqual(detail.resolved, "stored")
			assert.strictEqual(detail.sha, SHA)
		}).pipe(Effect.provide(commitLayer(testDb, layer)))
	})

	it.effect(
		"fetches an unstored commit from the provider, persists it, then serves it from storage",
		() => {
			const testDb = createTestDb(trackedDbs)
			const { layer, calls } = routedHttp((name) => name === "repo")
			const SHA = "c".repeat(40)
			return Effect.gen(function* () {
				const svc = yield* VcsCommitService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				// Two repos — the first 404s, the second resolves; the probe must continue.
				yield* seed(repo, orgId, [
					{ externalRepoId: "6", name: "other" },
					{ externalRepoId: "7", name: "repo" },
				])

				const detail = yield* svc.resolveCommitDetail(orgId, SHA)
				assert.strictEqual(detail.resolved, "fetched")
				assert.strictEqual(detail.sha, SHA)
				assert.strictEqual(detail.repoFullName, "octo/repo")
				assert.strictEqual(detail.authorLogin, "octocat")
				assert.strictEqual(detail.message.split("\n")[0], "Fix the thing")
				assert.ok(calls.commitGets >= 2, "should have probed both repos")

				// It was persisted: now stored, no further provider calls.
				const before = calls.commitGets
				const stored = expectSome(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA)))
				assert.strictEqual(
					stored.repositoryId,
					expectSome(yield* repo.resolveRepository(orgId, "github", "7")).id,
				)
				const second = yield* svc.resolveCommitDetail(orgId, SHA)
				assert.strictEqual(second.resolved, "stored")
				assert.strictEqual(calls.commitGets, before)
			}).pipe(Effect.provide(commitLayer(testDb, layer)))
		},
	)

	it.effect("returns VcsCommitNotFoundError when no repo has the SHA, and caches the miss", () => {
		const testDb = createTestDb(trackedDbs)
		const { layer, calls } = routedHttp(() => false)
		const SHA = "d".repeat(40)
		return Effect.gen(function* () {
			const svc = yield* VcsCommitService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			yield* seed(repo, orgId, [{ externalRepoId: "7", name: "repo" }])

			const exit = yield* svc.resolveCommitDetail(orgId, SHA).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof VcsCommitNotFoundError)
			const afterFirst = calls.commitGets
			assert.ok(afterFirst >= 1)

			// Second lookup is served from the negative cache — no new provider probe.
			const exit2 = yield* svc.resolveCommitDetail(orgId, SHA).pipe(Effect.exit)
			assert.ok(findError(exit2) instanceof VcsCommitNotFoundError)
			assert.strictEqual(calls.commitGets, afterFirst)
		}).pipe(Effect.provide(commitLayer(testDb, layer)))
	})

	it.effect("rejects a non-40-hex SHA with VcsCommitShaInvalidError before any provider call", () => {
		const testDb = createTestDb(trackedDbs)
		const { layer, calls } = routedHttp(() => true)
		return Effect.gen(function* () {
			const svc = yield* VcsCommitService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			yield* seed(repo, orgId, [{ externalRepoId: "7", name: "repo" }])

			for (const bad of ["abc1234", "not-a-sha", "g".repeat(40), "a".repeat(39)]) {
				const exit = yield* svc.resolveCommitDetail(orgId, bad).pipe(Effect.exit)
				assert.ok(
					findError(exit) instanceof VcsCommitShaInvalidError,
					`expected invalid-sha error for "${bad}"`,
				)
			}
			assert.strictEqual(calls.commitGets, 0)
		}).pipe(Effect.provide(commitLayer(testDb, layer)))
	})

	it.effect("returns IntegrationsNotConnectedError when the org has no active installation", () => {
		const testDb = createTestDb(trackedDbs)
		const { layer } = routedHttp(() => true)
		const SHA = "e".repeat(40)
		return Effect.gen(function* () {
			const svc = yield* VcsCommitService
			const orgId = asOrgId("org_test")
			const exit = yield* svc.resolveCommitDetail(orgId, SHA).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsNotConnectedError)
		}).pipe(Effect.provide(commitLayer(testDb, layer)))
	})
})
