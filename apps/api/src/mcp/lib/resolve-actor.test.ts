import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { ActorId, OrgId, UserId } from "@maple/domain/primitives"
import type { TenantContext } from "@/services/auth/tenant-context"
import { cleanupTestDbs, createTestDb, type TestDb } from "@/platform/test-pglite"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { resolveActor } from "./resolve-actor"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asActorId = Schema.decodeUnknownSync(ActorId)

const ORG = asOrgId("org_resolve_actor_test")
const USER = asUserId("user_resolve_actor_test")
const createdDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = () => ErrorActorsService.layer.pipe(Layer.provide(createTestDb(createdDbs).layer))

const tenantWith = (extra?: Partial<TenantContext>): TenantContext => ({
	orgId: ORG,
	userId: USER,
	roles: [],
	authMode: "self_hosted",
	...extra,
})

describe("resolveActor", () => {
	it.effect("prefers a pinned agent actorId without touching the database", () =>
		Effect.gen(function* () {
			const pinned = asActorId("00000000-0000-4000-8000-000000000001")
			const resolved = yield* resolveActor(tenantWith({ actorId: pinned }))
			assert.strictEqual(resolved.actorId, pinned)
			assert.isTrue(resolved.isAgent)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("attributes MCP-client sessions to a stable agent actor, not the user", () =>
		Effect.gen(function* () {
			const first = yield* resolveActor(tenantWith({ mcpClientName: "Claude Code" }))
			const second = yield* resolveActor(tenantWith({ mcpClientName: "claude-code" }))
			assert.isTrue(first.isAgent)
			assert.strictEqual(first.actorId, second.actorId)

			const actors = yield* ErrorActorsService
			const doc = yield* actors.lookupActor(ORG, first.actorId)
			assert.strictEqual(doc.type, "agent")
			assert.strictEqual(doc.agentName, "claude-code")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses reserved first-party names and falls back to the user actor", () =>
		Effect.gen(function* () {
			const resolved = yield* resolveActor(tenantWith({ mcpClientName: "maple-triage-agent" }))
			assert.isFalse(resolved.isAgent)

			const actors = yield* ErrorActorsService
			const doc = yield* actors.lookupActor(ORG, resolved.actorId)
			assert.strictEqual(doc.type, "user")
			assert.strictEqual(doc.userId, USER)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("falls back to the user actor when no client name is negotiated", () =>
		Effect.gen(function* () {
			const resolved = yield* resolveActor(tenantWith())
			assert.isFalse(resolved.isAgent)

			const actors = yield* ErrorActorsService
			const doc = yield* actors.lookupActor(ORG, resolved.actorId)
			assert.strictEqual(doc.type, "user")
		}).pipe(Effect.provide(makeLayer())),
	)
})
