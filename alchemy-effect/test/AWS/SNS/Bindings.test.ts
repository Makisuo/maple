import { destroy } from "@/Destroy";
import { afterAll, beforeAll, test } from "@/Test/Vitest";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";
import {
  SNSApiFunction,
  SNSApiFunctionLive,
  TopicAndQueue,
} from "./handler.ts";

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(9)),
);

let baseUrl: string;
let queueUrl: string;
let topicArn: string;
let subscriptionArn: string;

describe.sequential("SNS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SNS test setup: destroying previous resources");
      if (!process.env.NO_DESTROY) {
        yield* destroy();
      }

      yield* Effect.logInfo("SNS test setup: deploying fixture");
      const deployed = yield* test.deploy(
        Effect.gen(function* () {
          const { topic, queue, subscription } = yield* TopicAndQueue;

          const apiFunction = yield* SNSApiFunction;

          return {
            apiFunction,
            topic,
            queue,
            subscription,
          };
        }).pipe(Effect.provide(SNSApiFunctionLive)),
      );

      baseUrl = deployed.apiFunction.functionUrl!.replace(/\/+$/, "");
      queueUrl = deployed.queue.queueUrl;
      topicArn = deployed.topic.topicArn;
      subscriptionArn = deployed.subscription.subscriptionArn;

      const readinessUrl = `${baseUrl}/ready`;
      yield* Effect.logInfo(
        `SNS test setup: probing readiness at ${readinessUrl} (20s budget)`,
      );

      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tap(() =>
          Effect.logInfo("SNS test setup: fixture responded successfully"),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SNS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 120_000 },
  );

  if (!process.env.NO_DESTROY) {
    afterAll(destroy(), { timeout: 60_000 });
  }

  describe("Publish", () => {
    test(
      "publishes a message that reaches the Lambda event sink",
      Effect.gen(function* () {
        const marker = `publish-${crypto.randomUUID()}`;
        const response = yield* postJson("/publish", {
          message: marker,
          subject: "PublishTest",
        });

        expect((response as any).MessageId).toBeTruthy();

        const queued = yield* waitForQueueMessage(
          (body) => body.message === marker,
        );
        expect((queued as any).topicArn).toBe(topicArn);
        expect((queued as any).subject).toBe("PublishTest");
      }),
    );
  });

  describe("PublishBatch", () => {
    test(
      "publishes a batch of messages",
      Effect.gen(function* () {
        const first = `batch-1-${crypto.randomUUID()}`;
        const second = `batch-2-${crypto.randomUUID()}`;

        const response = yield* postJson("/publish-batch", {
          messages: [first, second],
        });

        expect(((response as any).Successful ?? []).length).toBe(2);

        const bodies = yield* waitForQueueMessages(2);
        const messages = bodies.map((body) => body.message);
        expect(messages).toContain(first);
        expect(messages).toContain(second);
      }),
    );
  });

  describe("GetTopicAttributes", () => {
    test(
      "gets the bound topic attributes",
      Effect.gen(function* () {
        const response = yield* getJson("/topic-attributes");
        expect((response as any).Attributes.TopicArn).toBe(topicArn);
      }),
    );
  });

  describe("SetTopicAttributes", () => {
    test(
      "updates topic attributes",
      Effect.gen(function* () {
        yield* postJson("/topic-attributes", {
          name: "DisplayName",
          value: "updated-display-name",
        });

        const response = yield* getJson("/topic-attributes");
        expect((response as any).Attributes.DisplayName).toBe(
          "updated-display-name",
        );
      }),
    );
  });

  describe("AddPermission", () => {
    test(
      "adds a topic policy statement",
      Effect.gen(function* () {
        yield* postJson("/add-permission", {});
        const response = yield* getJson("/topic-attributes");
        expect((response as any).Attributes.Policy).toContain(
          "FixturePublishPermission",
        );
      }),
    );
  });

  describe("RemovePermission", () => {
    test(
      "removes a topic policy statement",
      Effect.gen(function* () {
        yield* postJson("/add-permission", {});
        yield* postJson("/remove-permission", {});
        const response = yield* getJson("/topic-attributes");
        expect((response as any).Attributes.Policy ?? "").not.toContain(
          "FixturePublishPermission",
        );
      }),
    );
  });

  describe("GetDataProtectionPolicy", () => {
    test(
      "returns the topic data protection policy or a structured error",
      Effect.gen(function* () {
        const response = yield* getJson("/data-protection-policy");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect(response).toBeDefined();
        }
      }),
    );
  });

  describe("PutDataProtectionPolicy", () => {
    test(
      "invokes putDataProtectionPolicy",
      Effect.gen(function* () {
        const response = yield* postJson("/data-protection-policy", {
          policy: "{}",
        });
        expect(response).toBeDefined();
      }),
    );
  });

  describe("ListTopics", () => {
    test(
      "lists the deployed topic",
      Effect.gen(function* () {
        const response = yield* getJson("/topics");
        const arns = ((response as any).Topics ?? []).map(
          (topic: any) => topic.TopicArn,
        );
        expect(arns).toContain(topicArn);
      }),
    );
  });

  describe("ListSubscriptions", () => {
    test(
      "lists the deployed subscription",
      Effect.gen(function* () {
        const response = yield* getJson("/subscriptions");
        const arns = ((response as any).Subscriptions ?? []).map(
          (subscription: any) => subscription.SubscriptionArn,
        );
        expect(arns).toContain(subscriptionArn);
      }),
    );
  });

  describe("ListSubscriptionsByTopic", () => {
    test(
      "lists topic subscriptions",
      Effect.gen(function* () {
        const response = yield* getJson("/subscriptions-by-topic");
        const arns = ((response as any).Subscriptions ?? []).map(
          (subscription: any) => subscription.SubscriptionArn,
        );
        expect(arns).toContain(subscriptionArn);
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test(
      "lists the topic ownership tags",
      Effect.gen(function* () {
        const response = yield* getJson("/tags");
        const keys = ((response as any).Tags ?? []).map((tag: any) => tag.Key);
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
      }),
    );
  });

  describe("TagResource", () => {
    test(
      "adds a tag to the topic",
      Effect.gen(function* () {
        yield* postJson("/tags", {
          key: "sns-binding-test",
          value: "true",
        });
        const response = yield* getJson("/tags");
        const tags = Object.fromEntries(
          ((response as any).Tags ?? []).map((tag: any) => [
            tag.Key,
            tag.Value,
          ]),
        );
        expect(tags["sns-binding-test"]).toBe("true");
      }),
    );
  });

  describe("UntagResource", () => {
    test(
      "removes a tag from the topic",
      Effect.gen(function* () {
        yield* postJson("/tags", {
          key: "sns-remove-test",
          value: "true",
        });
        yield* deleteJson("/tags", {
          keys: ["sns-remove-test"],
        });
        const response = yield* getJson("/tags");
        const keys = ((response as any).Tags ?? []).map((tag: any) => tag.Key);
        expect(keys).not.toContain("sns-remove-test");
      }),
    );
  });

  describe("GetSubscriptionAttributes", () => {
    test(
      "gets the bound subscription attributes",
      Effect.gen(function* () {
        const response = yield* getJson("/subscription-attributes");
        expect((response as any).Attributes.Protocol).toBe("sqs");
      }),
    );
  });

  describe("SetSubscriptionAttributes", () => {
    test(
      "updates subscription attributes",
      Effect.gen(function* () {
        yield* postJson("/subscription-attributes", {
          name: "RawMessageDelivery",
          value: "true",
        });
        const response = yield* getJson("/subscription-attributes");
        expect((response as any).Attributes.RawMessageDelivery).toBe("true");
      }).pipe(
        Effect.ensuring(
          postJson("/subscription-attributes", {
            name: "RawMessageDelivery",
            value: "false",
          }).pipe(Effect.ignore),
        ),
      ),
    );
  });

  describe("ConfirmSubscription", () => {
    test(
      "returns a structured error for an invalid token",
      Effect.gen(function* () {
        const response = yield* postJson("/confirm-subscription", {
          token: "invalid-token",
        });
        expect((response as any).ok).toBe(false);
        expect((response as any).error).toBeTruthy();
      }),
    );
  });

  describe("TopicSink", () => {
    test(
      "publishes messages through the sink helper",
      Effect.gen(function* () {
        const first = `sink-1-${crypto.randomUUID()}`;
        const second = `sink-2-${crypto.randomUUID()}`;

        const response = yield* postJson("/sink", {
          messages: [first, second],
        });
        expect((response as any).ok).toBe(true);

        const bodies = yield* waitForQueueMessages(2);
        const messages = bodies.map((body) => body.message);
        expect(messages).toContain(first);
        expect(messages).toContain(second);
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
  ).pipe(
    Effect.tap((response) => Effect.flatMap(response.text, Effect.logInfo)),
    Effect.flatMap((response) => response.json),
  );

const deleteJson = (path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.delete(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((response) => response.json));

const waitForQueueMessages = Effect.fn(function* (count: number) {
  const bodies: Array<{ message: string; topicArn: string; subject?: string }> =
    [];

  while (bodies.length < count) {
    bodies.push(yield* waitForQueueMessage(() => true));
  }

  return bodies;
});

const waitForQueueMessage = Effect.fn(function* (
  predicate: (body: {
    message: string;
    topicArn: string;
    subject?: string;
  }) => boolean,
) {
  return yield* SQS.receiveMessage({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 2,
    VisibilityTimeout: 5,
  }).pipe(
    Effect.flatMap((result) => {
      const message = result.Messages?.[0];
      if (!message?.Body || !message.ReceiptHandle) {
        return Effect.fail(new QueueMessageNotReady());
      }

      const body = JSON.parse(message.Body) as {
        message: string;
        topicArn: string;
        subject?: string;
      };

      return SQS.deleteMessage({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }).pipe(
        Effect.flatMap(() =>
          predicate(body)
            ? Effect.succeed(body)
            : Effect.fail(new QueueMessageNotReady()),
        ),
      );
    }),
    Effect.retry({
      while: (error) => error._tag === "QueueMessageNotReady",
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(20)),
      ),
    }),
  );
});

class QueueMessageNotReady extends Data.TaggedError("QueueMessageNotReady") {}
