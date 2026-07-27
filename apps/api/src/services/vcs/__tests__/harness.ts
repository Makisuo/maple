import { assert } from "@effect/vitest"
import { createHmac, generateKeyPairSync } from "node:crypto"
import { OrgId, UserId, type VcsSyncJob } from "@maple/domain/http"
import { Cause, ConfigProvider, type Context, Effect, Exit, Layer, Option, Schema } from "effect"
import type { TestDb } from "@/lib/test-pglite"
import { Env } from "@/lib/Env"
import { GithubHttp, type GithubHttpShape } from "@/services/vcs/vendor/github/GithubHttp"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import { clampQueueDelaySeconds, VcsSyncQueue, type VcsSyncQueueShape } from "@/services/vcs/VcsSyncQueue"

// ---------------------------------------------------------------------------
// Shared test harness for the GitHub / VCS integration. The id-resolver
// helpers, config/env layers, scripted-HTTP seam, recording queue, and
// assertion utilities live here so the per-service test files don't each
// re-implement them.
// ---------------------------------------------------------------------------

export const asOrgId = Schema.decodeUnknownSync(OrgId)
export const asUserId = Schema.decodeUnknownSync(UserId)

// A real RSA key so the App-JWT mint (crypto.subtle.importKey) succeeds; the
// App's REST calls are always stubbed at the GithubHttp seam.
const APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

export const WEBHOOK_SECRET = "testsecret"

// HMAC-sign a webhook body the way GitHub does (`x-hub-signature-256`).
export const sign = (body: string) =>
	`sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`

// GitHub App config extras (slug + id + private key) layered on top of the base
// config for tests that exercise the App-authenticated client.
export const GITHUB_APP_CONFIG = {
	GITHUB_APP_SLUG: "maple-test-app",
	GITHUB_APP_ID: "123456",
	GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY,
	// Needed for the connect flow's OAuth check; without them a new connect is refused.
	GITHUB_APP_CLIENT_ID: "Iv1.testclientid",
	GITHUB_APP_CLIENT_SECRET: "test-client-secret",
} as const

const baseConfigValues = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
} as const

// ConfigProvider layer; `extra` adds (or overrides) keys such as the GitHub App
// config or the webhook secret. The DB comes from an in-memory PGlite TestDb, so
// no connection string is needed here.
const testConfig = (extra?: Record<string, unknown>) =>
	ConfigProvider.layer(ConfigProvider.fromUnknown({ ...baseConfigValues, ...extra }))

export const testEnv = (extra?: Record<string, unknown>) => Env.layer.pipe(Layer.provide(testConfig(extra)))

// VcsRepository over an in-memory PGlite TestDb + Env.
export const testRepoLayer = (testDb: TestDb, extra?: Record<string, unknown>) =>
	VcsRepository.layer.pipe(Layer.provide(testDb.layer), Layer.provide(testEnv(extra)))

export const jsonResponse = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
	new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json", ...init?.headers },
	})

// A GithubHttp seam replaying canned responses in call order; once the script is
// exhausted the last responder repeats (so rate-limit loops can keep replying).
export const scriptedHttp = (responders: ReadonlyArray<() => Response>) => {
	let i = 0
	return Layer.succeed(GithubHttp, {
		fetch: async () => {
			const make = responders[Math.min(i, responders.length - 1)]!
			i += 1
			return make()
		},
	} satisfies GithubHttpShape)
}

// A recording VcsSyncQueue: captures every enqueued job (and per-send delay).
// `failBatch` makes `sendBatch` fail instead, to exercise propagation.
//
// The recorded delay is run through the SAME `clampQueueDelaySeconds` the real
// queue producer applies (floor + [0, 86_400] clamp), so a regression that
// enqueued a fractional or out-of-range delay — which the live binding would
// reject outright — is observable here instead of being silently recorded raw.
export const recordingQueue = (
	sent: Array<VcsSyncJob>,
	opts?: { readonly sentDelays?: Array<number | undefined>; readonly failBatch?: () => unknown },
): VcsSyncQueueShape => ({
	send: (job, options) =>
		Effect.sync(() => {
			sent.push(job)
			opts?.sentDelays?.push(
				options?.delaySeconds === undefined
					? undefined
					: clampQueueDelaySeconds(options.delaySeconds),
			)
		}),
	sendBatch: (jobs) =>
		opts?.failBatch ? Effect.fail(opts.failBatch() as never) : Effect.sync(() => void sent.push(...jobs)),
})

export const recordingQueueLayer = (
	sent: Array<VcsSyncJob>,
	opts?: { readonly sentDelays?: Array<number | undefined>; readonly failBatch?: () => unknown },
) => Layer.succeed(VcsSyncQueue, recordingQueue(sent, opts))

// Pull the typed failure off an Exit, falling back to a squashed defect.
export const findError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	return failure ?? Cause.squash(exit.cause)
}

export const expectSome = <A>(o: Option.Option<A>): A => {
	assert.ok(Option.isSome(o), "expected Option.some, got none")
	return o.value
}

// ---------------------------------------------------------------------------
// The repo service speaks our internal ids; these resolve a row by its GitHub
// external id (the way the sync engine seeds it) and hand the id-based methods
// the entity, so tests can keep seeding/addressing by external id.
// ---------------------------------------------------------------------------

// The resolved service shape (the methods), distinct from the `VcsRepository`
// tag — `Context.Service.Shape` is how you name a class-service's instance type.
export type VcsRepo = Context.Service.Shape<typeof VcsRepository>

export const installationFor = (repo: VcsRepo, externalInstallationId: string) =>
	repo.resolveInstallation("github", externalInstallationId).pipe(Effect.map(expectSome))

export const repoFor = (repo: VcsRepo, orgId: OrgId, externalRepoId: string) =>
	repo.resolveRepository(orgId, "github", externalRepoId).pipe(Effect.map(expectSome))

export const upsertReposFor = (
	repo: VcsRepo,
	externalInstallationId: string,
	repos: Parameters<VcsRepo["upsertRepositories"]>[1],
) =>
	installationFor(repo, externalInstallationId).pipe(
		Effect.flatMap((i) => repo.upsertRepositories(i, repos)),
	)

export const upsertCommitsFor = (
	repo: VcsRepo,
	orgId: OrgId,
	externalRepoId: string,
	commits: Parameters<VcsRepo["upsertCommits"]>[1],
) => repoFor(repo, orgId, externalRepoId).pipe(Effect.flatMap((r) => repo.upsertCommits(r, commits)))

export const markRemovedFor = (repo: VcsRepo, orgId: OrgId, externalRepoId: string) =>
	repoFor(repo, orgId, externalRepoId).pipe(Effect.flatMap((r) => repo.markRepositoryRemoved(r.id)))

export const markInstStatusFor = (
	repo: VcsRepo,
	externalInstallationId: string,
	status: Parameters<VcsRepo["markInstallationStatus"]>[1],
) =>
	installationFor(repo, externalInstallationId).pipe(
		Effect.flatMap((i) => repo.markInstallationStatus(i.id, status)),
	)

export const purgeInstallationFor = (repo: VcsRepo, orgId: OrgId, externalInstallationId: string) =>
	repo.resolveInstallation("github", externalInstallationId).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.void,
				onSome: (i) => repo.purgeInstallation(orgId, i.id),
			}),
		),
	)

export const reposOfInstallation = (repo: VcsRepo, externalInstallationId: string, scope: "active" | "all") =>
	Effect.gen(function* () {
		const found = yield* repo.resolveInstallation("github", externalInstallationId)
		return Option.isNone(found) ? [] : yield* repo.listRepositoriesByInstallation(found.value.id, scope)
	})
