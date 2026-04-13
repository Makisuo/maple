import * as AWS from "@/AWS";
import { Stream } from "@/AWS/Kinesis";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

describe("AWS.Kinesis.Stream", () => {
  test(
    "create and delete stream with default props",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("DefaultStream");
        }),
      );

      expect(stream.streamName).toBeDefined();
      expect(stream.streamArn).toBeDefined();
      expect(stream.streamStatus).toEqual("ACTIVE");

      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
        "ACTIVE",
      );
      expect(
        streamDescription.StreamDescriptionSummary.StreamModeDetails
          ?.StreamMode,
      ).toEqual("ON_DEMAND");

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create, update, delete on-demand stream with tags",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("TestStream", {
            streamMode: "ON_DEMAND",
            tags: { Environment: "test" },
          });
        }),
      );

      // Verify the stream was created
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
        "ACTIVE",
      );
      expect(
        streamDescription.StreamDescriptionSummary.StreamModeDetails
          ?.StreamMode,
      ).toEqual("ON_DEMAND");
      expect(
        streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
      ).toEqual(24);

      // Verify tags
      const tagging = yield* Kinesis.listTagsForStream({
        StreamName: stream.streamName,
      });
      expect(tagging.Tags).toContainEqual({
        Key: "Environment",
        Value: "test",
      });

      // Update the stream - increase retention period and update tags
      yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("TestStream", {
            streamMode: "ON_DEMAND",
            retentionPeriodHours: 48,
            tags: { Environment: "production", Team: "platform" },
          });
        }),
      );

      // Verify the retention period was updated
      const updatedDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
      ).toEqual(48);

      // Verify tags were updated
      const updatedTagging = yield* Kinesis.listTagsForStream({
        StreamName: stream.streamName,
      });
      expect(updatedTagging.Tags).toContainEqual({
        Key: "Environment",
        Value: "production",
      });
      expect(updatedTagging.Tags).toContainEqual({
        Key: "Team",
        Value: "platform",
      });

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create provisioned stream with shards",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("ProvisionedStream", {
            streamMode: "PROVISIONED",
            shardCount: 2,
          });
        }),
      );

      // Verify the stream was created with shards
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
        "ACTIVE",
      );
      expect(
        streamDescription.StreamDescriptionSummary.StreamModeDetails
          ?.StreamMode,
      ).toEqual("PROVISIONED");
      expect(streamDescription.StreamDescriptionSummary.OpenShardCount).toEqual(
        2,
      );

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "update provisioned stream shard count",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("ShardStream", {
            streamMode: "PROVISIONED",
            shardCount: 1,
          });
        }),
      );

      // Verify initial shard count
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(streamDescription.StreamDescriptionSummary.OpenShardCount).toEqual(
        1,
      );

      // Update shard count
      yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("ShardStream", {
            streamMode: "PROVISIONED",
            shardCount: 2,
          });
        }),
      );

      // Verify shard count was updated
      const updatedDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        updatedDescription.StreamDescriptionSummary.OpenShardCount,
      ).toEqual(2);

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create stream with custom name",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const customName = `test-custom-kinesis-stream-custom-name-stream`;

      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("CustomNameStream", {
            streamName: customName,
          });
        }),
      );

      expect(stream.streamName).toEqual(customName);
      expect(stream.streamArn).toContain(customName);

      // Verify the stream exists
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: customName,
      });
      expect(streamDescription.StreamDescriptionSummary.StreamName).toEqual(
        customName,
      );

      yield* destroy();

      yield* assertStreamDeleted(customName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create stream with encryption",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("EncryptedStream", {
            encryption: true,
          });
        }),
      );

      // Verify the stream has encryption enabled
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(streamDescription.StreamDescriptionSummary.EncryptionType).toEqual(
        "KMS",
      );

      // Update to disable encryption
      yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("EncryptedStream", {
            encryption: false,
          });
        }),
      );

      // Verify encryption is disabled
      const updatedDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        updatedDescription.StreamDescriptionSummary.EncryptionType,
      ).toEqual("NONE");

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "create stream with enhanced monitoring and update metrics",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("MonitoredStream", {
            shardLevelMetrics: ["IncomingBytes", "OutgoingRecords"],
          });
        }),
      );

      // Verify enhanced monitoring is enabled
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      const metrics =
        streamDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
          ?.ShardLevelMetrics ?? [];
      expect(metrics).toContain("IncomingBytes");
      expect(metrics).toContain("OutgoingRecords");

      // Update metrics - add some, remove some
      yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("MonitoredStream", {
            shardLevelMetrics: [
              "IncomingBytes",
              "IncomingRecords",
              "IteratorAgeMilliseconds",
            ],
          });
        }),
      );

      // Verify metrics were updated
      const updatedDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      const updatedMetrics =
        updatedDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
          ?.ShardLevelMetrics ?? [];
      expect(updatedMetrics).toContain("IncomingBytes");
      expect(updatedMetrics).toContain("IncomingRecords");
      expect(updatedMetrics).toContain("IteratorAgeMilliseconds");
      expect(updatedMetrics).not.toContain("OutgoingRecords");

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "idempotent create - stream already exists",
    { timeout: 180_000 },
    Effect.gen(function* () {
      // First create
      const stream1 = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("IdempotentStream", {});
        }),
      );
      const streamName = stream1.streamName;

      // Second create (should be idempotent)
      const stream2 = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("IdempotentStream", {});
        }),
      );
      expect(stream2.streamName).toEqual(streamName);

      yield* destroy();

      yield* assertStreamDeleted(streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "switch stream mode from provisioned to on-demand",
    { timeout: 300_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("ModeChangeStream", {
            streamMode: "PROVISIONED",
            shardCount: 1,
          });
        }),
      );

      // Verify provisioned mode
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        streamDescription.StreamDescriptionSummary.StreamModeDetails
          ?.StreamMode,
      ).toEqual("PROVISIONED");

      // Update to on-demand mode
      yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("ModeChangeStream", {
            streamMode: "ON_DEMAND",
          });
        }),
      );

      // Verify on-demand mode
      const updatedDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        updatedDescription.StreamDescriptionSummary.StreamModeDetails
          ?.StreamMode,
      ).toEqual("ON_DEMAND");

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "decrease retention period",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("RetentionStream", {
            retentionPeriodHours: 48,
          });
        }),
      );

      // Verify initial retention period
      const streamDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
      ).toEqual(48);

      // Decrease retention period back to default
      yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("RetentionStream", {
            retentionPeriodHours: 24,
          });
        }),
      );

      // Verify retention period was decreased
      const updatedDescription = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
      ).toEqual(24);

      yield* destroy();

      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "update stream resource policy and max record size",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("PolicyStream", {
            streamMode: "PROVISIONED",
            shardCount: 1,
          });
        }),
      );

      const policy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowSameAccountDescribe",
            Effect: "Allow",
            Principal: {
              AWS: `arn:aws:iam::${stream.streamArn.split(":")[4]}:root`,
            },
            Action: ["kinesis:DescribeStreamSummary"],
            Resource: stream.streamArn,
          },
        ],
      });

      const updated = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("PolicyStream", {
            streamMode: "PROVISIONED",
            shardCount: 1,
            resourcePolicy: policy,
            maxRecordSizeInKiB: 2048,
          });
        }),
      );

      expect(updated.resourcePolicy).toContain("AllowSameAccountDescribe");
      expect(updated.maxRecordSizeInKiB).toEqual(2048);

      const policyResponse = yield* Kinesis.getResourcePolicy({
        ResourceARN: stream.streamArn,
      });
      expect(policyResponse.Policy).toContain("AllowSameAccountDescribe");

      const summary = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(summary.StreamDescriptionSummary.MaxRecordSizeInKiB).toEqual(2048);

      yield* destroy();
      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  test(
    "update warm throughput when account supports it",
    { timeout: 240_000 },
    Effect.gen(function* () {
      const accountSettings = yield* Kinesis.describeAccountSettings({});
      const status =
        accountSettings.MinimumThroughputBillingCommitment?.Status ??
        "DISABLED";

      if (status === "DISABLED") {
        return;
      }

      const stream = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("WarmThroughputStream");
        }),
      );

      const updated = yield* test.deploy(
        Effect.gen(function* () {
          return yield* Stream("WarmThroughputStream", {
            warmThroughputMiBps: 10,
          });
        }),
      );

      expect(updated.warmThroughput?.targetMiBps).toEqual(10);

      const summary = yield* Kinesis.describeStreamSummary({
        StreamName: stream.streamName,
      });
      expect(
        summary.StreamDescriptionSummary.WarmThroughput?.TargetMiBps,
      ).toEqual(10);

      yield* destroy();
      yield* assertStreamDeleted(stream.streamName);
    }).pipe(Effect.provide(AWS.providers())),
  );

  class StreamStillExists extends Data.TaggedError("StreamStillExists") {}

  const assertStreamDeleted = Effect.fn(function* (streamName: string) {
    yield* Kinesis.describeStreamSummary({
      StreamName: streamName,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new StreamStillExists())),
      Effect.retry({
        while: (e: { _tag: string }) =>
          e._tag === "StreamStillExists" ||
          // During stream deletion, AWS may return incomplete responses that fail parsing
          e._tag === "ParseError",
        schedule: Schedule.exponential(500).pipe(
          Schedule.both(Schedule.recurs(30)),
        ),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
  });
});
