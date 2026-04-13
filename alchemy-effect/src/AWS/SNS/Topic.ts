import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type TopicName = string;
export type TopicArn = `arn:aws:sns:${RegionID}:${AccountID}:${TopicName}`;

export interface TopicProps {
  /**
   * Name of the topic.
   * @default ${app}-${stage}-${id}?.fifo
   */
  topicName?: string;
  /**
   * Whether to create a FIFO topic.
   * @default false
   */
  fifo?: boolean;
  /**
   * Raw SNS topic attributes keyed by AWS attribute name.
   * Use this for delivery policies, tracing, KMS, signatures, archive policy, and
   * other SNS topic attributes not modeled as first-class props.
   */
  attributes?: Record<string, string>;
  /**
   * SNS data protection policy JSON for the topic.
   *
   * TODO(sam): should this be a typed object that we serialize/deserialize?
   */
  dataProtectionPolicy?: string;
  /**
   * User-defined tags to apply to the topic.
   */
  tags?: Record<string, string>;
}

export interface Topic extends Resource<
  "AWS.SNS.Topic",
  TopicProps,
  {
    topicArn: TopicArn;
    topicName: TopicName;
    fifo: boolean;
    attributes: Record<string, string>;
    dataProtectionPolicy: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An Amazon SNS topic for fan-out messaging and notifications.
 *
 * `Topic` owns the SNS topic lifecycle while raw AWS topic attributes remain
 * available through the `attributes` prop so the full core pub/sub surface can be
 * configured without waiting on additional typed wrappers.
 *
 * @section Creating Topics
 * @example Standard Topic
 * ```typescript
 * const topic = yield* Topic("OrdersTopic", {
 *   topicName: "orders-events",
 * });
 * ```
 *
 * @example FIFO Topic
 * ```typescript
 * const topic = yield* Topic("OrdersFifoTopic", {
 *   fifo: true,
 *   attributes: {
 *     ContentBasedDeduplication: "true",
 *   },
 * });
 * ```
 *
 * @section Runtime Publishing
 * @example Publish from a Lambda Function
 * ```typescript
 * const publish = yield* SNS.Publish.bind(topic);
 *
 * yield* publish({
 *   Message: JSON.stringify({ orderId: "123" }),
 *   Subject: "OrderCreated",
 * });
 * ```
 */
export const Topic = Resource<Topic>("AWS.SNS.Topic");

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    read: Effect.fn(function* ({ id, olds, output }) {
      const topicName =
        output?.topicName ?? (yield* toTopicName(id, olds ?? {}));

      return yield* readTopic({
        id,
        topicArn: output?.topicArn,
        topicName,
      });
    }),
    stables: ["topicArn", "topicName", "fifo"],
    diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
      if (!isResolved(news)) return undefined;
      if ((news.fifo ?? false) !== (olds.fifo ?? false)) {
        return { action: "replace" } as const;
      }

      const oldTopicName = yield* toTopicName(id, olds);
      const newTopicName = yield* toTopicName(id, news);

      if (oldTopicName !== newTopicName) {
        return { action: "replace" } as const;
      }

      if (
        olds.dataProtectionPolicy !== undefined &&
        news.dataProtectionPolicy === undefined
      ) {
        return { action: "replace" } as const;
      }
    }),
    create: Effect.fn(function* ({ id, news = {}, session }) {
      const topicName = yield* toTopicName(id, news);
      const tags = {
        ...(yield* createInternalTags(id)),
        ...news.tags,
      };

      const response = yield* sns.createTopic({
        Name: topicName,
        Attributes: toAttributes(news),
        Tags: createTagsList(tags),
        DataProtectionPolicy: news.dataProtectionPolicy,
      });

      const topicArn = response.TopicArn;

      if (!topicArn) {
        return yield* Effect.die(new Error(`createTopic returned no ARN`));
      }

      yield* session.note(topicArn);

      return {
        topicArn: topicArn as TopicArn,
        topicName,
        fifo: news.fifo ?? false,
        attributes: toAttributes(news),
        dataProtectionPolicy: news.dataProtectionPolicy,
        tags,
      };
    }),
    update: Effect.fn(function* ({
      id,
      news = {},
      olds = {},
      output,
      session,
    }) {
      const newAttributes = toAttributes(news);
      const oldAttributes = toAttributes(olds);

      for (const [name, value] of Object.entries(newAttributes)) {
        if (oldAttributes[name] !== value) {
          yield* sns.setTopicAttributes({
            TopicArn: output.topicArn,
            AttributeName: name,
            AttributeValue: value,
          });
        }
      }

      for (const name of Object.keys(oldAttributes)) {
        if (!(name in newAttributes)) {
          yield* sns.setTopicAttributes({
            TopicArn: output.topicArn,
            AttributeName: name,
          });
        }
      }

      const newTags = {
        ...(yield* createInternalTags(id)),
        ...news.tags,
      };
      const oldTags = {
        ...(yield* createInternalTags(id)),
        ...olds.tags,
      };
      const { removed, upsert } = diffTags(oldTags, newTags);

      if (upsert.length > 0) {
        yield* sns.tagResource({
          ResourceArn: output.topicArn,
          Tags: upsert,
        });
      }

      if (removed.length > 0) {
        yield* sns.untagResource({
          ResourceArn: output.topicArn,
          TagKeys: removed,
        });
      }

      if (
        news.dataProtectionPolicy !== undefined &&
        news.dataProtectionPolicy !== olds.dataProtectionPolicy
      ) {
        yield* sns.putDataProtectionPolicy({
          ResourceArn: output.topicArn,
          DataProtectionPolicy: news.dataProtectionPolicy,
        });
      }

      yield* session.note(output.topicArn);

      return {
        ...output,
        fifo: news.fifo ?? false,
        attributes: newAttributes,
        dataProtectionPolicy:
          news.dataProtectionPolicy ?? output.dataProtectionPolicy,
        tags: newTags,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* sns
        .deleteTopic({
          TopicArn: output.topicArn,
        })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.void),
          Effect.catchTag("InvalidParameterException", () => Effect.void),
        );
    }),
  });

const toTopicName = Effect.fn(function* (id: string, props: TopicProps) {
  if (props.topicName) {
    return props.topicName;
  }

  const baseName = yield* createPhysicalName({
    id,
    maxLength: props.fifo ? 256 - ".fifo".length : 256,
  });

  return props.fifo ? `${baseName}.fifo` : baseName;
});

const toAttributes = (props: TopicProps): Record<string, string> => ({
  ...props.attributes,
  ...(props.fifo ? { FifoTopic: "true" } : undefined),
});

const toTagMap = (tags: sns.Tag[] | undefined): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is Required<Pick<sns.Tag, "Key" | "Value">> =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttributeMap = (
  attributes: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const findTopicArnByName = Effect.fn(function* (topicName: string) {
  let nextToken: string | undefined;

  while (true) {
    const response = yield* sns.listTopics({
      NextToken: nextToken,
    });

    const match = response.Topics?.find(
      (topic) => topic.TopicArn?.split(":").at(-1) === topicName,
    )?.TopicArn;

    if (match) {
      return match;
    }

    if (!response.NextToken) {
      return undefined;
    }

    nextToken = response.NextToken;
  }
});

const readTopic = Effect.fn(function* ({
  id,
  topicArn,
  topicName,
}: {
  id: string;
  topicArn?: string;
  topicName: string;
}) {
  const resolvedTopicArn = topicArn ?? (yield* findTopicArnByName(topicName));

  if (!resolvedTopicArn) {
    return undefined;
  }

  const topicState = yield* Effect.all(
    [
      sns.getTopicAttributes({
        TopicArn: resolvedTopicArn,
      }),
      sns.listTagsForResource({
        ResourceArn: resolvedTopicArn,
      }),
      sns
        .getDataProtectionPolicy({
          ResourceArn: resolvedTopicArn,
        })
        .pipe(
          Effect.map((response) => response.DataProtectionPolicy),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidParameterException", () =>
      Effect.succeed(undefined),
    ),
  );

  if (!topicState) {
    return undefined;
  }

  const [attributes, tags, dataProtectionPolicy] = topicState;

  const topicAttributes = toAttributeMap(attributes.Attributes);

  return {
    topicArn: resolvedTopicArn as TopicArn,
    topicName: topicAttributes.TopicArn?.split(":").at(-1) ?? topicName,
    fifo: topicAttributes.FifoTopic === "true",
    attributes: topicAttributes,
    dataProtectionPolicy,
    tags: {
      ...(yield* createInternalTags(id)),
      ...toTagMap(tags.Tags),
    },
  };
});
