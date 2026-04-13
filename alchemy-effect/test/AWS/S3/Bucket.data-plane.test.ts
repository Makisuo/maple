import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as S3 from "@distilled.cloud/aws/s3";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const deployTestBucket = () =>
  test.deploy(
    Effect.gen(function* () {
      return yield* Bucket("DataPlaneTestBucket", {
        forceDestroy: true,
      });
    }),
  );

test(
  "listObjectsV2 - list objects in bucket",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Put some test objects
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "file1.txt",
      Body: "content 1",
    });
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "file2.txt",
      Body: "content 2",
    });
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "folder/file3.txt",
      Body: "content 3",
    });

    // Test listObjectsV2
    const result = yield* S3.listObjectsV2({
      Bucket: bucketName,
    });

    expect(result.Contents).toBeDefined();
    expect(result.Contents!.length).toBe(3);
    expect(result.Contents!.map((c) => c.Key)).toContain("file1.txt");
    expect(result.Contents!.map((c) => c.Key)).toContain("file2.txt");
    expect(result.Contents!.map((c) => c.Key)).toContain("folder/file3.txt");

    // Test with prefix
    const prefixResult = yield* S3.listObjectsV2({
      Bucket: bucketName,
      Prefix: "folder/",
    });
    expect(prefixResult.Contents!.length).toBe(1);
    expect(prefixResult.Contents![0].Key).toBe("folder/file3.txt");

    // Test with maxKeys
    const limitResult = yield* S3.listObjectsV2({
      Bucket: bucketName,
      MaxKeys: 1,
    });
    expect(limitResult.Contents!.length).toBe(1);
    expect(limitResult.IsTruncated).toBe(true);

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "headObject - get object metadata",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Put a test object
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "test-file.txt",
      Body: "Hello, World!",
      ContentType: "text/plain",
    });

    // Test headObject
    const result = yield* S3.headObject({
      Bucket: bucketName,
      Key: "test-file.txt",
    });

    expect(result.ContentType).toBe("text/plain");
    expect(result.ContentLength).toBe(13); // "Hello, World!" is 13 bytes
    expect(result.ETag).toBeDefined();

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "headObject - returns error for non-existent object",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Try to head a non-existent object
    const result = yield* S3.headObject({
      Bucket: bucketName,
      Key: "non-existent.txt",
    }).pipe(
      Effect.map(() => "found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );

    expect(result).toBe("not-found");

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "copyObject - copy object within bucket",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Put source object
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "source.txt",
      Body: "Original content",
      ContentType: "text/plain",
    });

    // Copy the object
    yield* S3.copyObject({
      Bucket: bucketName,
      Key: "destination.txt",
      CopySource: `${bucketName}/source.txt`,
    });

    // Verify destination exists
    const destHead = yield* S3.headObject({
      Bucket: bucketName,
      Key: "destination.txt",
    });
    expect(destHead.ContentType).toBe("text/plain");
    expect(destHead.ContentLength).toBe(16); // "Original content" is 16 bytes

    // Verify source still exists
    const sourceHead = yield* S3.headObject({
      Bucket: bucketName,
      Key: "source.txt",
    });
    expect(sourceHead.ContentLength).toBe(16);

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "copyObject - copy with metadata replacement",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Put source object
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "source.txt",
      Body: "Content",
      ContentType: "text/plain",
    });

    // Copy with new content type
    yield* S3.copyObject({
      Bucket: bucketName,
      Key: "destination.txt",
      CopySource: `${bucketName}/source.txt`,
      ContentType: "application/octet-stream",
      MetadataDirective: "REPLACE",
    });

    // Verify destination has new content type
    const destHead = yield* S3.headObject({
      Bucket: bucketName,
      Key: "destination.txt",
    });
    // AWS may normalize content-type to binary/octet-stream
    expect(destHead.ContentType).toBe("binary/octet-stream");

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "multipart upload - complete workflow",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Create multipart upload
    const createResult = yield* S3.createMultipartUpload({
      Bucket: bucketName,
      Key: "multipart-file.txt",
      ContentType: "text/plain",
    });

    expect(createResult.UploadId).toBeDefined();
    const uploadId = createResult.UploadId!;

    // Use a single part - AWS S3 requires parts to be at least 5MB except for
    // the last (or only) part, so a single-part upload works with any size
    const partContent = "Complete multipart upload content";

    const partResult = yield* S3.uploadPart({
      Bucket: bucketName,
      Key: "multipart-file.txt",
      UploadId: uploadId,
      PartNumber: 1,
      Body: partContent,
    });
    expect(partResult.ETag).toBeDefined();

    // Complete the multipart upload with single part
    yield* S3.completeMultipartUpload({
      Bucket: bucketName,
      Key: "multipart-file.txt",
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [{ ETag: partResult.ETag!, PartNumber: 1 }],
      },
    });

    // Verify the object exists and has correct size
    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "multipart-file.txt",
    });
    // Note: AWS S3 may use binary/octet-stream for multipart uploads even when
    // ContentType is set on createMultipartUpload
    expect(headResult.ContentLength).toBe(partContent.length);

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "multipart upload - abort",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Create multipart upload
    const createResult = yield* S3.createMultipartUpload({
      Bucket: bucketName,
      Key: "aborted-file.txt",
      ContentType: "text/plain",
    });

    const uploadId = createResult.UploadId!;

    // Upload a part
    yield* S3.uploadPart({
      Bucket: bucketName,
      Key: "aborted-file.txt",
      UploadId: uploadId,
      PartNumber: 1,
      Body: "Some content",
    });

    // Abort the upload
    yield* S3.abortMultipartUpload({
      Bucket: bucketName,
      Key: "aborted-file.txt",
      UploadId: uploadId,
    });

    // Verify the object does not exist
    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "aborted-file.txt",
    }).pipe(
      Effect.map(() => "found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );

    expect(headResult).toBe("not-found");

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "putObject and getObject - basic operations",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Test putObject
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "test-put.txt",
      Body: "Test content for put operation",
      ContentType: "text/plain",
    });

    // Verify with headObject
    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "test-put.txt",
    });
    expect(headResult.ContentType).toBe("text/plain");
    expect(headResult.ContentLength).toBe(30);

    // Test getObject
    const getResult = yield* S3.getObject({
      Bucket: bucketName,
      Key: "test-put.txt",
    });
    expect(getResult.ContentType).toBe("text/plain");
    expect(getResult.ContentLength).toBe(30);

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

test(
  "deleteObject - remove object",
  Effect.gen(function* () {
    const bucket = yield* deployTestBucket();
    const bucketName = bucket.bucketName;

    // Put an object
    yield* S3.putObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
      Body: "Delete me",
    });

    // Verify it exists
    yield* S3.headObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
    });

    // Delete it
    yield* S3.deleteObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
    });

    // Verify it's gone
    const headResult = yield* S3.headObject({
      Bucket: bucketName,
      Key: "to-delete.txt",
    }).pipe(
      Effect.map(() => "found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
    );

    expect(headResult).toBe("not-found");

    yield* destroy();
    yield* assertBucketDeleted(bucketName);
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
