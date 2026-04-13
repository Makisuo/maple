import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

test.skipIf(process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS !== "true")(
  "create and delete a CloudFront Function with key value store associations",
  { timeout: 300_000 },
  Effect.gen(function* () {
    yield* destroy();

    const deployed = yield* test.deploy(
      Effect.gen(function* () {
        const store = yield* AWS.CloudFront.KeyValueStore("RequestStore", {
          comment: "request metadata",
        });
        const fn = yield* AWS.CloudFront.Function("RequestFn", {
          comment: "request handler",
          keyValueStoreArns: [store.keyValueStoreArn],
          code: `async function handler(event) {
  return event.request;
}`,
        });
        return { store, fn };
      }),
    );

    const current = yield* cloudfront.describeFunction({
      Name: deployed.fn.functionName,
      Stage: "LIVE",
    });
    expect(current.FunctionSummary?.Name).toEqual(deployed.fn.functionName);
    expect(
      current.FunctionSummary?.FunctionConfig.KeyValueStoreAssociations
        ?.Items?.[0]?.KeyValueStoreARN,
    ).toEqual(deployed.store.keyValueStoreArn);

    yield* destroy();
    yield* assertFunctionDeleted(deployed.fn.functionName);
  }).pipe(Effect.provide(AWS.providers())),
);

const assertFunctionDeleted = (name: string) =>
  cloudfront
    .describeFunction({
      Name: name,
      Stage: "LIVE",
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new Error("FunctionStillExists"))),
      Effect.catchTag("NoSuchFunctionExists", () => Effect.void),
      Effect.retry({
        while: (error) =>
          error instanceof Error && error.message === "FunctionStillExists",
        schedule: Schedule.fixed("5 seconds").pipe(
          Schedule.both(Schedule.recurs(24)),
        ),
      }),
    );
