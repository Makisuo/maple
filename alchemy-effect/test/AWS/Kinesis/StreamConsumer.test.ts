import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

describe("AWS.Kinesis.StreamConsumer", () => {
  test(
    "create, update tags, and delete a stream consumer",
    { timeout: 180_000 },
    Effect.gen(function* () {
      const deployed = yield* test.deploy(
        Effect.gen(function* () {
          const stream = yield* AWS.Kinesis.Stream("ConsumerSourceStream", {
            streamMode: "PROVISIONED",
            shardCount: 1,
          });

          const consumer = yield* AWS.Kinesis.StreamConsumer(
            "AnalyticsConsumer",
            {
              streamArn: stream.streamArn,
              tags: {
                fixture: "consumer-test",
              },
            },
          );

          return { stream, consumer };
        }),
      );

      const description = yield* Kinesis.describeStreamConsumer({
        ConsumerARN: deployed.consumer.consumerArn,
      });
      expect(description.ConsumerDescription.ConsumerStatus).toEqual("ACTIVE");

      const initialTags = yield* Kinesis.listTagsForResource({
        ResourceARN: deployed.consumer.consumerArn,
      });
      expect(initialTags.Tags).toContainEqual({
        Key: "fixture",
        Value: "consumer-test",
      });

      const updated = yield* test.deploy(
        Effect.gen(function* () {
          const stream = yield* AWS.Kinesis.Stream("ConsumerSourceStream", {
            streamMode: "PROVISIONED",
            shardCount: 1,
          });

          const consumer = yield* AWS.Kinesis.StreamConsumer(
            "AnalyticsConsumer",
            {
              streamArn: stream.streamArn,
              tags: {
                fixture: "consumer-test-updated",
                team: "platform",
              },
            },
          );

          return { stream, consumer };
        }),
      );

      const updatedTags = yield* Kinesis.listTagsForResource({
        ResourceARN: updated.consumer.consumerArn,
      });
      expect(updatedTags.Tags).toContainEqual({
        Key: "fixture",
        Value: "consumer-test-updated",
      });
      expect(updatedTags.Tags).toContainEqual({
        Key: "team",
        Value: "platform",
      });

      yield* destroy();

      const deleted = yield* Kinesis.describeStreamConsumer({
        ConsumerARN: updated.consumer.consumerArn,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(true),
        ),
      );
      expect(deleted).toBe(true);
    }).pipe(Effect.provide(AWS.providers())),
  );
});
