import { destroy } from "@/Destroy";
import { afterAll, beforeAll, test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";
import KinesisApiFunctionLive, { KinesisApiFunction } from "./handler.ts";

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(9)),
);

let baseUrl: string;
let streamName: string;
let consumerName: string;

describe.sequential("Kinesis Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* destroy();
      const deployed = yield* test.deploy(
        Effect.gen(function* () {
          return yield* KinesisApiFunction;
        }).pipe(Effect.provide(KinesisApiFunctionLive)),
      );

      baseUrl = deployed.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tap((response) =>
          response.json.pipe(
            Effect.tap((json) => {
              streamName = (json as any).streamName;
              consumerName = (json as any).consumerName;

              return Effect.void;
            }),
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 120_000 },
  );

  afterAll(destroy(), { timeout: 60_000 });

  describe("DescribeAccountSettings", () => {
    test(
      "returns the account settings payload",
      Effect.gen(function* () {
        const response = yield* getJson("/account-settings");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("DescribeLimits", () => {
    test(
      "returns shard and stream limits",
      Effect.gen(function* () {
        const response = yield* getJson("/limits");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value.ShardLimit).toBeGreaterThan(0);
        }
      }),
    );
  });

  describe("ListStreams", () => {
    test(
      "lists the deployed stream",
      Effect.gen(function* () {
        const response = yield* getJson("/streams");
        const names = (response as any).StreamNames ?? [];
        expect(names).toContain(streamName);
      }),
    );
  });

  describe("DescribeStream", () => {
    test(
      "describes the bound stream",
      Effect.gen(function* () {
        const response = yield* getJson("/stream");
        expect((response as any).StreamDescription.StreamName).toBe(streamName);
      }),
    );
  });

  describe("DescribeStreamSummary", () => {
    test(
      "describes the bound stream summary",
      Effect.gen(function* () {
        const response = yield* getJson("/stream-summary");
        expect((response as any).StreamDescriptionSummary.StreamName).toBe(
          streamName,
        );
      }),
    );
  });

  describe("GetResourcePolicy", () => {
    test(
      "returns the stream policy or a structured error",
      Effect.gen(function* () {
        const response = yield* getJson("/resource-policy");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("ListShards", () => {
    test(
      "lists shards for the stream",
      Effect.gen(function* () {
        const response = yield* getJson("/shards");
        expect(((response as any).Shards ?? []).length).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetShardIterator", () => {
    test(
      "returns a shard iterator for the first shard",
      Effect.gen(function* () {
        const shardId = yield* getFirstShardId();
        const response = yield* postJson("/iterator", { shardId });
        expect((response as any).ShardIterator).toBeTruthy();
      }),
    );
  });

  describe("GetRecords", () => {
    test(
      "reads a just-written record through the shard iterator",
      Effect.gen(function* () {
        const shardId = yield* getFirstShardId();
        const marker = `records-${crypto.randomUUID()}`;
        const response = yield* postJson("/records", {
          shardId,
          partitionKey: "records-test",
          data: marker,
        });
        const records = (response as any).records ?? [];
        expect(records.some((record: any) => record.data === marker)).toBe(
          true,
        );
      }),
    );
  });

  describe("ListStreamConsumers", () => {
    test(
      "lists the registered consumer",
      Effect.gen(function* () {
        const response = yield* getJson("/stream-consumers");
        const consumers = (response as any).Consumers ?? [];
        expect(
          consumers.some(
            (consumer: any) => consumer.ConsumerName === consumerName,
          ),
        ).toBe(true);
      }),
    );
  });

  describe("DescribeStreamConsumer", () => {
    test(
      "describes the registered consumer",
      Effect.gen(function* () {
        const response = yield* getJson("/consumer");
        expect((response as any).ConsumerDescription.ConsumerName).toBe(
          consumerName,
        );
      }),
    );
  });

  describe("SubscribeToShard", () => {
    test(
      "opens a subscribe-to-shard stream",
      Effect.gen(function* () {
        const shardId = yield* getFirstShardId();
        const response = yield* postJson("/subscribe", { shardId });
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test(
      "lists the stream ownership tags",
      Effect.gen(function* () {
        const response = yield* getJson("/tags");
        const keys = ((response as any).Tags ?? []).map((tag: any) => tag.Key);
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
        expect(keys).toContain("fixture");
      }),
    );
  });

  describe("PutRecord", () => {
    test(
      "writes a single record",
      Effect.gen(function* () {
        const response = yield* postJson("/put-record", {
          partitionKey: "put-record",
          data: `put-record-${crypto.randomUUID()}`,
        });
        expect((response as any).ShardId).toBeTruthy();
        expect((response as any).SequenceNumber).toBeTruthy();
      }),
    );
  });

  describe("PutRecords", () => {
    test(
      "writes a batch of records",
      Effect.gen(function* () {
        const response = yield* postJson("/put-records", {
          records: [
            {
              partitionKey: "put-records",
              data: `batch-1-${crypto.randomUUID()}`,
            },
            {
              partitionKey: "put-records",
              data: `batch-2-${crypto.randomUUID()}`,
            },
          ],
        });
        expect((response as any).FailedRecordCount ?? 0).toBe(0);
        expect(((response as any).Records ?? []).length).toBe(2);
      }),
    );
  });

  describe("StreamSink", () => {
    test(
      "writes records through the sink helper",
      Effect.gen(function* () {
        const response = yield* postJson("/sink", {
          records: [
            { partitionKey: "sink", data: `sink-1-${crypto.randomUUID()}` },
            { partitionKey: "sink", data: `sink-2-${crypto.randomUUID()}` },
          ],
        });
        expect((response as any).ok).toBe(true);
      }),
    );
  });
});

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) => response.json),
  );

const postJson = (path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((response) => response.json));

const getFirstShardId = () =>
  getJson("/shards").pipe(
    Effect.map((response) => (response as any).Shards?.[0]?.ShardId as string),
  );
