import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export type SubscriptionArn = string;

export interface SubscriptionProps {
  /**
   * ARN of the topic to subscribe to.
   */
  topicArn: Input<string>;
  /**
   * SNS subscription protocol, for example `lambda`, `sqs`, `https`, or `email`.
   */
  protocol: string;
  /**
   * Endpoint for the selected protocol, such as a Lambda function ARN or queue ARN.
   */
  endpoint?: Input<string>;
  /**
   * Raw SNS subscription attributes keyed by AWS attribute name.
   */
  attributes?: Record<string, string>;
  /**
   * Whether SNS should return the subscription ARN immediately, even while pending confirmation.
   * @default true
   */
  returnSubscriptionArn?: boolean;
}

export interface Subscription extends Resource<
  "AWS.SNS.Subscription",
  SubscriptionProps,
  {
    subscriptionArn: SubscriptionArn;
    topicArn: string;
    protocol: string;
    endpoint: string | undefined;
    owner: string | undefined;
    pendingConfirmation: boolean;
    attributes: Record<string, string>;
  }
> {}

/**
 * An Amazon SNS subscription that attaches an endpoint to a topic.
 *
 * `Subscription` keeps the lifecycle of the subscription itself separate from the
 * topic, which lets Lambda event sources and manually managed subscriptions share
 * the same canonical resource model.
 *
 * @section Creating Subscriptions
 * @example Lambda Subscription
 * ```typescript
 * const subscription = yield* Subscription("TopicSubscription", {
 *   topicArn: topic.topicArn,
 *   protocol: "lambda",
 *   endpoint: fn.functionArn,
 * });
 * ```
 */
export const Subscription = Resource<Subscription>("AWS.SNS.Subscription");

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    read: Effect.fn(function* ({ olds, output }) {
      return yield* readSubscription({
        subscriptionArn: output?.subscriptionArn,
        topicArn: (output?.topicArn ?? olds.topicArn) as string | undefined,
        protocol: output?.protocol ?? olds.protocol,
        endpoint: (output?.endpoint ?? olds.endpoint) as string | undefined,
      });
    }),
    stables: ["subscriptionArn"],
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.protocol !== olds.protocol) {
        return { action: "replace" } as const;
      }

      if (
        typeof news.topicArn === "string" &&
        typeof olds.topicArn === "string" &&
        news.topicArn !== olds.topicArn
      ) {
        return { action: "replace" } as const;
      }

      if (
        typeof news.endpoint === "string" &&
        typeof olds.endpoint === "string" &&
        news.endpoint !== olds.endpoint
      ) {
        return { action: "replace" } as const;
      }
    }),
    create: Effect.fn(function* ({ news, session }) {
      const response = yield* sns.subscribe({
        TopicArn: news.topicArn as string,
        Protocol: news.protocol,
        Endpoint: news.endpoint as string | undefined,
        Attributes: news.attributes,
        ReturnSubscriptionArn: news.returnSubscriptionArn ?? true,
      });

      const subscriptionArn = response.SubscriptionArn;

      if (!subscriptionArn) {
        return yield* Effect.die(new Error(`subscribe returned no ARN`));
      }

      yield* session.note(subscriptionArn);

      return {
        subscriptionArn,
        topicArn: news.topicArn as string,
        protocol: news.protocol,
        endpoint: news.endpoint as string | undefined,
        owner: undefined,
        pendingConfirmation: isPendingConfirmation(subscriptionArn),
        attributes: toAttributeMap(news.attributes),
      };
    }),
    update: Effect.fn(function* ({ news, olds, output, session }) {
      const oldAttributes = toAttributeMap(olds.attributes);
      const newAttributes = toAttributeMap(news.attributes);

      for (const [name, value] of Object.entries(newAttributes)) {
        if (oldAttributes[name] !== value) {
          yield* sns.setSubscriptionAttributes({
            SubscriptionArn: output.subscriptionArn,
            AttributeName: name,
            AttributeValue: value,
          });
        }
      }

      for (const name of Object.keys(oldAttributes)) {
        if (!(name in newAttributes)) {
          yield* sns.setSubscriptionAttributes({
            SubscriptionArn: output.subscriptionArn,
            AttributeName: name,
          });
        }
      }

      yield* session.note(output.subscriptionArn);

      return {
        ...output,
        topicArn: news.topicArn as string,
        protocol: news.protocol,
        endpoint: news.endpoint as string | undefined,
        attributes: newAttributes,
      };
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const subscriptionArn = isPendingConfirmation(output.subscriptionArn)
        ? yield* findSubscription({
            topicArn: (output.topicArn ?? olds.topicArn) as string | undefined,
            protocol: output.protocol ?? olds.protocol,
            endpoint: (output.endpoint ?? olds.endpoint) as string | undefined,
          })
        : output.subscriptionArn;

      if (!subscriptionArn) {
        return;
      }

      yield* sns
        .unsubscribe({
          SubscriptionArn: subscriptionArn,
        })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.void),
          Effect.catchTag("InvalidParameterException", () => Effect.void),
        );
    }),
  });

const isPendingConfirmation = (subscriptionArn: string | undefined) =>
  subscriptionArn === undefined ||
  subscriptionArn.toLowerCase() === "pending confirmation";

const toAttributeMap = (
  attributes: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const findSubscription = Effect.fn(function* ({
  topicArn,
  protocol,
  endpoint,
}: {
  topicArn: string | undefined;
  protocol: string | undefined;
  endpoint: string | undefined;
}) {
  if (!topicArn || !protocol) {
    return undefined;
  }

  let nextToken: string | undefined;

  while (true) {
    const response = yield* sns.listSubscriptionsByTopic({
      TopicArn: topicArn,
      NextToken: nextToken,
    });

    const match = response.Subscriptions?.find(
      (subscription) =>
        subscription.Protocol === protocol &&
        subscription.Endpoint === endpoint,
    );

    if (match?.SubscriptionArn) {
      return match.SubscriptionArn;
    }

    if (!response.NextToken) {
      return undefined;
    }

    nextToken = response.NextToken;
  }
});

const readSubscription = Effect.fn(function* ({
  subscriptionArn,
  topicArn,
  protocol,
  endpoint,
}: {
  subscriptionArn?: string;
  topicArn?: string;
  protocol?: string;
  endpoint: string | undefined;
}) {
  const resolvedSubscriptionArn =
    subscriptionArn && !isPendingConfirmation(subscriptionArn)
      ? subscriptionArn
      : yield* findSubscription({
          topicArn,
          protocol,
          endpoint,
        });

  if (!resolvedSubscriptionArn) {
    if (!topicArn || !protocol) {
      return undefined;
    }

    return {
      subscriptionArn: subscriptionArn ?? "pending confirmation",
      topicArn,
      protocol,
      endpoint,
      owner: undefined,
      pendingConfirmation: true,
      attributes: {},
    };
  }

  const response = yield* sns
    .getSubscriptionAttributes({
      SubscriptionArn: resolvedSubscriptionArn,
    })
    .pipe(
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      Effect.catchTag("InvalidParameterException", () =>
        Effect.succeed(undefined),
      ),
    );

  if (!response) {
    return undefined;
  }

  const attributes = toAttributeMap(response.Attributes);
  const resolvedTopicArn = attributes.TopicArn ?? topicArn;
  const resolvedProtocol = attributes.Protocol ?? protocol;

  if (!resolvedTopicArn || !resolvedProtocol) {
    return undefined;
  }

  return {
    subscriptionArn: resolvedSubscriptionArn,
    topicArn: resolvedTopicArn,
    protocol: resolvedProtocol,
    endpoint: attributes.Endpoint ?? endpoint,
    owner: attributes.Owner,
    pendingConfirmation:
      attributes.PendingConfirmation === "true" ||
      isPendingConfirmation(resolvedSubscriptionArn),
    attributes,
  };
});
