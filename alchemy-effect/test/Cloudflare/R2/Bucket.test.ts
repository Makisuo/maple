import * as Cloudflare from "@/Cloudflare";
import { Account } from "@/Cloudflare/Account";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as r2 from "@distilled.cloud/cloudflare/r2";
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
  "create and delete bucket with default props",
  Effect.gen(function* () {
    const accountId = yield* Account;

    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.storageClass).toEqual("Standard");
    expect(bucket.jurisdiction).toEqual("default");

    const actualBucket = yield* r2.getBucket({
      accountId,
      bucketName: bucket.bucketName,
    });
    expect(actualBucket.name).toEqual(bucket.bucketName);

    yield* destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete bucket",
  Effect.gen(function* () {
    const accountId = yield* Account;

    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "Standard",
        });
      }),
    );

    const actualBucket = yield* r2.getBucket({
      accountId,
      bucketName: bucket.bucketName,
    });
    expect(actualBucket.name).toEqual(bucket.bucketName);
    expect(actualBucket.storageClass).toEqual("Standard");

    // Update the bucket
    const updatedBucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "InfrequentAccess",
        });
      }),
    );

    const actualUpdatedBucket = yield* r2.getBucket({
      accountId,
      bucketName: updatedBucket.bucketName,
    });
    expect(actualUpdatedBucket.name).toEqual(updatedBucket.bucketName);
    expect(actualUpdatedBucket.storageClass).toEqual("InfrequentAccess");

    yield* destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  yield* r2
    .getBucket({
      accountId,
      bucketName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (e): e is BucketStillExists => e instanceof BucketStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}
