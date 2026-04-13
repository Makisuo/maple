import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

test(
  "create and delete bucket with default props",
  Effect.gen(function* () {
    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.bucketArn).toBeDefined();
    expect(bucket.region).toBeDefined();

    yield* S3.headBucket({ Bucket: bucket.bucketName });

    yield* destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create, update, delete bucket",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TestBucket", {
          bucketName: "alchemy-test-bucket-crud",
          tags: { Environment: "test" },
          forceDestroy: true,
        });
      }),
    );

    // Verify the bucket was created
    yield* S3.headBucket({ Bucket: bucket.bucketName });

    // Verify tags
    const tagging = yield* S3.getBucketTagging({
      Bucket: bucket.bucketName,
    });
    expect(tagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "test",
    });

    // Update the bucket tags
    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TestBucket", {
          bucketName: "alchemy-test-bucket-crud",
          tags: { Environment: "production", Team: "platform" },
          forceDestroy: true,
        });
      }),
    );

    // Verify tags were updated
    const updatedTagging = yield* S3.getBucketTagging({
      Bucket: bucket.bucketName,
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Environment",
      Value: "production",
    });
    expect(updatedTagging.TagSet).toContainEqual({
      Key: "Team",
      Value: "platform",
    });

    yield* destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create bucket with custom name",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("CustomNameBucket", {
          bucketName: "alchemy-test-bucket-custom-name",
          forceDestroy: true,
        });
      }),
    );

    expect(bucket.bucketName).toEqual("alchemy-test-bucket-custom-name");
    expect(bucket.bucketArn).toEqual(
      "arn:aws:s3:::alchemy-test-bucket-custom-name",
    );

    // Verify the bucket exists
    yield* S3.headBucket({ Bucket: bucket.bucketName });

    yield* destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create bucket with forceDestroy",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ForceDestroyBucket", {
          bucketName: "alchemy-test-bucket-force-destroy",
          forceDestroy: true,
        });
      }),
    );

    // Put an object in the bucket
    yield* S3.putObject({
      Bucket: bucket.bucketName,
      Key: "test-object.txt",
      Body: "Hello, World!",
    });

    // Verify the object exists
    yield* S3.headObject({
      Bucket: bucket.bucketName,
      Key: "test-object.txt",
    });

    // Destroy should succeed even with objects in the bucket
    yield* destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "idempotent create - bucket already exists",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    // First create
    const bucket1 = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("IdempotentBucket", {
          bucketName: "alchemy-test-bucket-idempotent",
          forceDestroy: true,
        });
      }),
    );
    const bucketName = bucket1.bucketName;

    // Second create (should be idempotent)
    const bucket2 = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("IdempotentBucket", {
          bucketName: "alchemy-test-bucket-idempotent",
          forceDestroy: true,
        });
      }),
    );
    expect(bucket2.bucketName).toEqual(bucketName);

    yield* destroy();

    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create bucket with objectLockEnabled",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("ObjectLockBucket", {
          bucketName: "alchemy-test-bucket-object-lock",
          objectLockEnabled: true,
          forceDestroy: true,
        });
      }),
    );

    // Verify Object Lock is enabled
    const objectLockConfig = yield* S3.getObjectLockConfiguration({
      Bucket: bucket.bucketName,
    });
    expect(objectLockConfig.ObjectLockConfiguration?.ObjectLockEnabled).toEqual(
      "Enabled",
    );

    yield* destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "remove all tags from bucket",
  Effect.gen(function* () {
    // Clean up any previous state
    yield* destroy();

    // Create bucket with tags
    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TagRemovalBucket", {
          bucketName: "alchemy-test-bucket-tag-removal",
          tags: { Environment: "test", Team: "platform" },
          forceDestroy: true,
        });
      }),
    );
    const bucketName = bucket.bucketName;

    // Verify tags exist
    const tagging = yield* S3.getBucketTagging({
      Bucket: bucketName,
    });
    expect(tagging.TagSet).toHaveLength(2);

    // Update to remove all tags
    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("TagRemovalBucket", {
          bucketName: "alchemy-test-bucket-tag-removal",
          forceDestroy: true,
        });
      }),
    );

    // Verify all tags were removed (NoSuchTagSet error expected)
    const result = yield* S3.getBucketTagging({
      Bucket: bucketName,
    }).pipe(
      Effect.map(() => "has-tags" as const),
      Effect.catchTag("NoSuchTagSet", () => Effect.succeed("no-tags" as const)),
    );
    expect(result).toEqual("no-tags");

    yield* destroy();

    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "create and remove bucket policy from bindings",
  Effect.gen(function* () {
    yield* destroy();

    const distributionArn =
      "arn:aws:cloudfront::123456789012:distribution/TESTDIST";
    const bucketArn = "arn:aws:s3:::alchemy-test-bucket-policy-bindings";

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        const bucket = yield* Bucket("PolicyBucket", {
          bucketName: "alchemy-test-bucket-policy-bindings",
          forceDestroy: true,
        });

        yield* bucket.bind("AWS.S3.Policy(TestDistribution, PolicyBucket)", {
          policyStatements: [
            {
              Effect: "Allow",
              Principal: {
                Service: "cloudfront.amazonaws.com",
              },
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/*`],
              Condition: {
                StringEquals: {
                  "AWS:SourceArn": distributionArn,
                },
              },
            },
          ],
        });

        return bucket;
      }),
    );

    const bucketPolicy = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(Effect.map((response) => JSON.parse(response.Policy!)));
    const statement = bucketPolicy.Statement[0];

    expect(bucketPolicy.Version).toEqual("2012-10-17");
    expect(statement.Effect).toEqual("Allow");
    expect(statement.Principal).toEqual({
      Service: "cloudfront.amazonaws.com",
    });
    expect(statement.Action).toEqual("s3:GetObject");
    expect(statement.Resource).toEqual(`${bucketArn}/*`);
    expect(statement.Condition).toEqual({
      StringEquals: {
        "AWS:SourceArn": distributionArn,
      },
    });

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Bucket("PolicyBucket", {
          bucketName: "alchemy-test-bucket-policy-bindings",
          forceDestroy: true,
        });
      }),
    );

    const policyAfterRemoval = yield* S3.getBucketPolicy({
      Bucket: bucket.bucketName,
    }).pipe(
      Effect.map(() => "has-policy" as const),
      Effect.catchTag("NoSuchBucketPolicy", () =>
        Effect.succeed("no-policy" as const),
      ),
    );

    expect(policyAfterRemoval).toEqual("no-policy");

    yield* destroy();

    yield* assertBucketDeleted(bucket.bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}

const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  yield* S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() => Effect.fail(new BucketStillExists())),
    Effect.retry({
      while: (e) => e._tag === "BucketStillExists",
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch(() => Effect.void),
  );
});
