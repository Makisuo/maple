import { Region } from "@distilled.cloud/aws/Region";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Account, type AccountID } from "../Account.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { RegionID } from "../Region.ts";

export type QueueName = string;
export type QueueArn = `arn:aws:sqs:${RegionID}:${AccountID}:${QueueName}`;
export type QueueUrl = string;

export type QueueProps = {
  /**
   * Name of the queue.
   * @default ${app}-${stage}-${id}?.fifo
   */
  queueName?: string;
  /**
   * Delay in seconds for all messages in the queue (`0` - `900`).
   * @default 0
   */
  delaySeconds?: number;
  /**
   * Maximum message size in bytes (`1,024` - `1,048,576`).
   * @default 1048576
   */
  maximumMessageSize?: number;
  /**
   * Message retention period in seconds (`60` - `1,209,600`).
   * @default 345600
   */
  messageRetentionPeriod?: number;
  /**
   * Time in seconds for `ReceiveMessage` to wait for a message (`0` - `20`).
   * @default 0
   */
  receiveMessageWaitTimeSeconds?: number;
  /**
   * Visibility timeout in seconds (`0` - `43,200`).
   * @default 30
   */
  visibilityTimeout?: number;
} & (
  | {
      fifo?: false;
      contentBasedDeduplication?: undefined;
      deduplicationScope?: undefined;
      fifoThroughputLimit?: undefined;
    }
  | {
      fifo: true;
      /**
       * Enables content-based deduplication for FIFO queues. Only valid when `fifo` is `true`.
       * @default false
       */
      contentBasedDeduplication?: boolean;
      /**
       * Specifies whether message deduplication occurs at the message group or queue level.
       * Valid values are `messageGroup` and `queue`. Only valid when `fifo` is `true`.
       */
      deduplicationScope?: "messageGroup" | "queue";
      /**
       * Specifies whether the FIFO queue throughput quota applies to the entire queue or per message group.
       * Valid values are `perQueue` and `perMessageGroupId`. Only valid when `fifo` is `true`.
       */
      fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
    }
);

export interface Queue extends Resource<
  "AWS.SQS.Queue",
  QueueProps,
  {
    queueUrl: string;
    queueName: QueueName;
    queueArn: QueueArn;
  },
  {
    policyStatements: PolicyStatement[];
  }
> {}

export const Queue = Resource<Queue>("AWS.SQS.Queue");

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;
      const createQueueName = Effect.fnUntraced(function* (
        id: string,
        props: {
          queueName?: string | undefined;
          fifo?: boolean;
        },
      ) {
        if (props.queueName) {
          return props.queueName;
        }
        const baseName = yield* createPhysicalName({
          id,
          maxLength: props.fifo ? 80 - ".fifo".length : 80,
        });
        return props.fifo ? `${baseName}.fifo` : baseName;
      });
      const createAttributes = (
        props: QueueProps,
        bindings: ResourceBinding<Queue["Binding"]>[],
      ) => {
        const baseAttributes: Record<string, string | undefined> = {
          DelaySeconds: props.delaySeconds?.toString(),
          MaximumMessageSize: props.maximumMessageSize?.toString(),
          MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
          ReceiveMessageWaitTimeSeconds:
            props.receiveMessageWaitTimeSeconds?.toString(),
          VisibilityTimeout: props.visibilityTimeout?.toString(),
          Policy:
            bindings.length > 0
              ? JSON.stringify({
                  Version: "2012-10-17",
                  Statement: bindings.flatMap((p) => p.data.policyStatements),
                })
              : undefined,
        };

        if (props.fifo) {
          return {
            ...baseAttributes,
            FifoQueue: "true",
            FifoThroughputLimit: props.fifoThroughputLimit,
            ContentBasedDeduplication: props.contentBasedDeduplication
              ? "true"
              : "false",
            DeduplicationScope: props.deduplicationScope,
          };
        }

        return baseAttributes;
      };
      return Queue.Provider.of({
        stables: ["queueName", "queueUrl", "queueArn"],
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldFifo = olds.fifo ?? false;
          const newFifo = news.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" } as const;
          }
          const oldQueueName = yield* createQueueName(id, olds);
          const newQueueName = yield* createQueueName(id, news);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" } as const;
          }
          // Return undefined to allow update function to be called for other attribute changes
        }),
        create: Effect.fn(function* ({ id, news = {}, session, bindings }) {
          const queueName = yield* createQueueName(id, news);
          const response = yield* sqs
            .createQueue({
              QueueName: queueName,
              Attributes: createAttributes(news, bindings),
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDeletedRecently",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.tapOutput((i) =>
                    session.note(
                      `Queue was deleted recently, retrying... ${i + 1}s`,
                    ),
                  ),
                ),
              }),
            );
          const queueArn =
            `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
          const queueUrl = response.QueueUrl!;
          yield* session.note(queueUrl);
          return {
            queueName,
            queueUrl,
            queueArn: queueArn,
          };
        }),
        update: Effect.fn(function* ({ news = {}, output, session, bindings }) {
          const attributes = createAttributes(news, bindings);
          if (Object.values(attributes).some((a) => a !== undefined)) {
            yield* sqs.setQueueAttributes({
              QueueUrl: output.queueUrl,
              Attributes: attributes,
            });
          }
          yield* session.note(output.queueUrl);
          return output;
        }),
        delete: Effect.fn(function* (input) {
          yield* sqs
            .deleteQueue({
              QueueUrl: input.output.queueUrl,
            })
            .pipe(Effect.catchTag("QueueDoesNotExist", () => Effect.void));
        }),
      });
    }),
  );
