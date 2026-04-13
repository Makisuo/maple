import { Account } from "@/Cloudflare/Account";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as R2 from "@/Cloudflare/R2";
import { destroy } from "@/Destroy";
import { Stack } from "@/Stack";
import { test } from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import InternalWorker from "./internal-worker.ts";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "worker.ts");

test(
  "create, update, delete worker",
  Effect.gen(function* () {
    const accountId = yield* Account;
    const stack = yield* Stack;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        const bucket = yield* R2.R2Bucket("Bucket", {
          storageClass: "Standard",
        });

        const worker = yield* Cloudflare.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });

        return worker;
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${stack.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${stack.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:TestWorker",
    );

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorker", {
          main,
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* findWorker(
      updatedWorker.workerName,
      accountId,
    );
    expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
    const actualUpdatedSubdomain = yield* workers.getScriptSubdomain({
      accountId,
      scriptName: updatedWorker.workerName,
    });
    expect(actualUpdatedSubdomain).toEqual({
      enabled: true,
      previewsEnabled: true,
    });

    yield* destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete worker with assets",
  Effect.gen(function* () {
    const accountId = yield* Account;
    const stack = yield* Stack;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${stack.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${stack.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:TestWorkerWithAssets",
    );

    // Verify the worker has assets
    expect(worker.hash?.assets).toBeDefined();

    // Verify the worker is accessible via URL
    if (worker.url) {
      yield* Effect.logInfo(`Worker with Assets URL: ${worker.url}`);
    }

    // Update the worker
    const updatedWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    const actualUpdatedWorker = yield* findWorker(
      updatedWorker.workerName,
      accountId,
    );
    expect(actualUpdatedWorker?.scriptName).toEqual(updatedWorker.workerName);
    expect(updatedWorker.hash?.assets).toBeDefined();

    // Final update
    const finalWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Worker("TestWorkerWithAssets", {
          main,
          url: true,
          assets: pathe.resolve(import.meta.dirname, "assets"),
          subdomain: { enabled: true, previewsEnabled: true },
          compatibility: {
            date: "2024-01-01",
          },
        });
      }),
    );

    yield* destroy();

    yield* waitForWorkerToBeDeleted(finalWorker.workerName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete internal worker",
  Effect.gen(function* () {
    const accountId = yield* Account;
    const stack = yield* Stack;

    yield* destroy();

    const worker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* InternalWorker;
      }),
    );

    const actualWorker = yield* findWorker(worker.workerName, accountId);
    expect(actualWorker?.scriptName).toEqual(worker.workerName);
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stack:${stack.name}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      `alchemy:stage:${stack.stage}`,
    );
    expect(yield* getWorkerTags(worker.workerName, accountId)).toContain(
      "alchemy:id:InternalWorker",
    );

    const updatedWorker = yield* test.deploy(
      Effect.gen(function* () {
        return yield* InternalWorker;
      }),
    );

    expect(updatedWorker.workerName).toEqual(worker.workerName);

    yield* destroy();

    yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const findWorker = Effect.fn(function* (workerName: string, accountId: string) {
  const matches = yield* workers.searchScript({
    accountId,
    name: workerName,
  });
  return matches.find((worker) => worker.scriptName === workerName);
});

const getWorkerTags = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  const settings = yield* workers.getScriptScriptAndVersionSetting({
    accountId,
    scriptName: workerName,
  });
  return settings.tags ?? [];
});

const waitForWorkerToBeDeleted = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  yield* workers
    .getScript({
      accountId,
      scriptName: workerName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new WorkerStillExists())),
      Effect.retry({
        while: (e): e is WorkerStillExists => e instanceof WorkerStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("WorkerNotFound", () => Effect.void),
    );
});

class WorkerStillExists extends Data.TaggedError("WorkerStillExists") {}
