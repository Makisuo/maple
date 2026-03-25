import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Entity, ShardingConfig } from "effect/unstable/cluster"
import { TestEntity, TestEntityLayer, User } from "./TestEntity.ts"

describe.concurrent("Entity", () => {
  describe("makeTestClient", () => {
    it.effect("round trip", () =>
      Effect.gen(function*() {
        const makeClient = yield* Entity.makeTestClient(TestEntity, TestEntityLayer)
        const client = yield* makeClient("123")
        const user = yield* client.GetUser({ id: 1 })
        assert.deepEqual(user, new User({ id: 1, name: "User 1" }))
      }).pipe(Effect.provide(TestShardingConfig)))
  })
})

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100
})
