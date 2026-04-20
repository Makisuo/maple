import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import { SqlClient, SqlModel, SqlResolver } from "effect/unstable/sql"
import { MysqlContainer } from "./utils.ts"

class User extends Model.Class<User>("User")({
  id: Model.Generated(Schema.Int),
  name: Schema.String,
  age: Schema.Int
}) {}

describe("SqlModel", () => {
  it.effect("insert returns result", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`

      const result = yield* repo.insert(User.insert.make({ name: "Alice", age: 30 }))
      assert.deepStrictEqual(result, new User({ id: 1, name: "Alice", age: 30 }))
    }).pipe(
      Effect.provide(MysqlContainer.layerClient),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  it.effect("insert returns result with transforms", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`

      const result = yield* repo.insert(User.insert.make({ name: "Alice", age: 30 }))
      assert.deepStrictEqual(result, new User({ id: 1, name: "Alice", age: 30 }))
    }).pipe(
      Effect.provide(MysqlContainer.layerClientWithTransforms),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  it.effect("insertVoid", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`

      const result = yield* repo.insertVoid(User.insert.make({ name: "Alice", age: 30 }))
      assert.strictEqual(result, void 0)
    }).pipe(
      Effect.provide(MysqlContainer.layerClient),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  it.live("insert data loader returns result", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeResolvers(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`

      const [alice, john] = yield* Effect.all([
        SqlResolver.request(User.insert.make({ name: "Alice", age: 30 }), repo.insert),
        SqlResolver.request(User.insert.make({ name: "John", age: 30 }), repo.insert)
      ], { concurrency: "unbounded" })
      assert.deepStrictEqual(alice.name, "Alice")
      assert.deepStrictEqual(john.name, "John")
    }).pipe(
      Effect.provide(MysqlContainer.layerClient),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  it.live("findById data loader", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeResolvers(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`
      const alice = yield* SqlResolver.request(User.insert.make({ name: "Alice", age: 30 }), repo.insert)
      const john = yield* SqlResolver.request(User.insert.make({ name: "John", age: 30 }), repo.insert)

      const [alice2, john2] = yield* Effect.all([
        SqlResolver.request(alice.id, repo.findById),
        SqlResolver.request(john.id, repo.findById)
      ], { concurrency: "unbounded" })

      assert.deepStrictEqual(alice2.name, "Alice")
      assert.deepStrictEqual(john2.name, "John")
    }).pipe(
      Effect.provide(MysqlContainer.layerClient),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  it.effect("update returns result", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`

      let result = yield* repo.insert(User.insert.make({ name: "Alice", age: 30 }))
      result = yield* repo.update(User.update.make({ ...result, name: "Bob" }))
      assert.deepStrictEqual(result, new User({ id: 1, name: "Bob", age: 30 }))
    }).pipe(
      Effect.provide(MysqlContainer.layerClient),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })

  it.effect("update returns result with transforms", () =>
    Effect.gen(function*() {
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        idColumn: "id",
        spanPrefix: "UserRepository"
      })
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), age INT)`

      let result = yield* repo.insert(User.insert.make({ name: "Alice", age: 30 }))
      result = yield* repo.update(User.update.make({ ...result, name: "Bob" }))
      assert.deepStrictEqual(result, new User({ id: 1, name: "Bob", age: 30 }))
    }).pipe(
      Effect.provide(MysqlContainer.layerClientWithTransforms),
      Effect.catchTag("ContainerError", () => Effect.void)
    ), { timeout: 60_000 })
})
