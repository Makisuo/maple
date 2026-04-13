import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import KinesisStreamFunctionLive, {
  KinesisStreamFunction,
} from "./stream-handler.ts";

describe.sequential("AWS.Kinesis.StreamEventSource", () => {
  test(
    "processes real Kinesis records through Lambda",
    { timeout: 240_000 },
    Effect.gen(function* () {
      yield* destroy();

      const streamFunction = yield* test.deploy(
        KinesisStreamFunction.asEffect().pipe(
          Effect.provide(KinesisStreamFunctionLive),
        ),
      );

      const functionUrl = streamFunction.functionUrl!;

      const { streamName, streamArn } = yield* HttpClient.get(functionUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<{
                streamName: string;
                streamArn: string;
              }>)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.fixed("1 seconds") }),
      );

      yield* waitForEventSourceMappingEnabled(
        streamFunction.functionName,
        streamArn,
      );
      yield* Effect.sleep("10 seconds");

      yield* Kinesis.putRecord({
        StreamName: streamName,
        PartitionKey: "stream-event-source",
        Data: new TextEncoder().encode("payload"),
      });
      yield* Effect.sleep("5 seconds");

      const mapping = yield* waitForEventSourceMappingEnabled(
        streamFunction.functionName,
        streamArn,
      );
      expect(mapping.State).toEqual("Enabled");

      yield* destroy();
    }).pipe(Effect.provide(AWS.providers())),
  );
});

const waitForEventSourceMappingEnabled = Effect.fn(function* (
  functionName: string,
  eventSourceArn: string,
) {
  return yield* Lambda.listEventSourceMappings({
    FunctionName: functionName,
    EventSourceArn: eventSourceArn,
  }).pipe(
    Effect.flatMap((result) => {
      const mapping = result.EventSourceMappings?.[0];
      if (!mapping || mapping.State !== "Enabled") {
        return Effect.fail(new EventSourceMappingNotReady());
      }
      return Effect.succeed(mapping);
    }),
    Effect.retry({
      while: (error) => error._tag === "EventSourceMappingNotReady",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

class EventSourceMappingNotReady extends Data.TaggedError(
  "EventSourceMappingNotReady",
) {}
