import * as Cloudflare from "@/Cloudflare";
import { Account } from "@/Cloudflare/Account";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "create and delete database with default props",
  Effect.gen(function* () {
    const accountId = yield* Account;

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("DefaultDatabase");
      }),
    );

    expect(database.databaseName).toBeDefined();
    expect(database.databaseId).toBeDefined();

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    yield* destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete database",
  Effect.gen(function* () {
    const accountId = yield* Account;

    yield* destroy();

    const database = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("TestDatabase", {
          readReplication: { mode: "disabled" },
        });
      }),
    );

    const actualDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: database.databaseId,
    });
    expect(actualDatabase.uuid).toEqual(database.databaseId);

    const updatedDatabase = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.D1Database("TestDatabase", {
          readReplication: { mode: "auto" },
        });
      }),
    );

    expect(updatedDatabase.databaseId).toEqual(database.databaseId);

    const actualUpdatedDatabase = yield* d1.getDatabase({
      accountId,
      databaseId: updatedDatabase.databaseId,
    });
    expect(actualUpdatedDatabase.readReplication?.mode).toEqual("auto");

    yield* destroy();

    yield* waitForDatabaseToBeDeleted(database.databaseId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const waitForDatabaseToBeDeleted = Effect.fn(function* (
  databaseId: string,
  accountId: string,
) {
  yield* d1
    .getDatabase({
      accountId,
      databaseId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("DatabaseNotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
