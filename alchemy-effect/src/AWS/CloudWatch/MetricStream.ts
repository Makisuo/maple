import { Region } from "@distilled.cloud/aws/Region";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account, type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";
import {
  createName,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type MetricStreamName = string;
export type MetricStreamArn =
  `arn:aws:cloudwatch:${RegionID}:${AccountID}:metric-stream/${string}`;

export interface MetricStreamProps extends Omit<
  cloudwatch.PutMetricStreamInput,
  "Name" | "Tags"
> {
  /**
   * Name of the metric stream. If omitted, a unique name is generated.
   */
  name?: MetricStreamName;
  /**
   * Whether the stream should be running after deployment.
   * @default true
   */
  enabled?: boolean;
  /**
   * Optional tags to apply to the metric stream.
   */
  tags?: Record<string, string>;
}

export interface MetricStream extends Resource<
  "AWS.CloudWatch.MetricStream",
  MetricStreamProps,
  {
    metricStreamName: MetricStreamName;
    metricStreamArn: MetricStreamArn;
    state: string | undefined;
    metricStream: cloudwatch.GetMetricStreamOutput;
    tags: Record<string, string>;
  }
> {}

/**
 * A CloudWatch metric stream.
 *
 * @section Creating Metric Streams
 * @example Firehose Delivery Stream
 * ```typescript
 * const stream = yield* MetricStream("MetricsExport", {
 *   FirehoseArn: "arn:aws:firehose:us-east-1:123456789012:deliverystream/example",
 *   RoleArn: "arn:aws:iam::123456789012:role/example",
 *   OutputFormat: "json",
 * });
 * ```
 */
export const MetricStream = Resource<MetricStream>(
  "AWS.CloudWatch.MetricStream",
);

export const MetricStreamProvider = () =>
  Provider.effect(
    MetricStream,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;
      const createMetricStreamName = (
        id: string,
        props: { name?: string } = {},
      ) => createName(id, props.name, 255);

      const metricStreamArn = (name: string) =>
        `arn:aws:cloudwatch:${region}:${accountId}:metric-stream/${name}` as MetricStreamArn;

      const readMetricStream = Effect.fn(function* (name: string) {
        const output = yield* cloudwatch
          .getMetricStream({
            Name: name,
          })
          .pipe(
            Effect.catchTag("InvalidParameterValueException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!output?.Name || !output.Arn) {
          return undefined;
        }

        const tags = yield* readResourceTags(output.Arn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
          Effect.catchTag("InvalidParameterValueException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          metricStreamName: output.Name,
          metricStreamArn: output.Arn as MetricStreamArn,
          state: output.State,
          metricStream: output,
          tags,
        };
      });

      const syncMetricStreamState = Effect.fn(function* ({
        name,
        enabled,
      }: {
        name: string;
        enabled: boolean | undefined;
      }) {
        if (enabled === false) {
          yield* retryConcurrent(
            cloudwatch.stopMetricStreams({
              Names: [name],
            }),
          );
          return;
        }

        yield* retryConcurrent(
          cloudwatch.startMetricStreams({
            Names: [name],
          }),
        );
      });

      return {
        stables: ["metricStreamName", "metricStreamArn"],
        diff: Effect.fn(function* ({
          id,
          olds = {},
          news = {} as Input<MetricStreamProps>,
        }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createMetricStreamName(id, olds);
          const newName = yield* createMetricStreamName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.metricStreamName ??
            (yield* createMetricStreamName(id, olds ?? {}));
          return yield* readMetricStream(name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createMetricStreamName(id, news);
          const existing = yield* readMetricStream(name);

          if (existing) {
            yield* ensureOwnedByAlchemy(
              id,
              name,
              existing.tags,
              "metric stream",
            );
          }

          yield* retryConcurrent(
            cloudwatch.putMetricStream({
              ...news,
              Name: name,
            }),
          );
          yield* syncMetricStreamState({
            name,
            enabled: news.enabled,
          });

          const tags = yield* updateResourceTags({
            id,
            resourceArn: metricStreamArn(name),
            olds: existing?.tags,
            news: news.tags,
          });

          yield* session.note(metricStreamArn(name));

          const state = yield* readMetricStream(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read created metric stream '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* retryConcurrent(
            cloudwatch.putMetricStream({
              ...news,
              Name: output.metricStreamName,
            }),
          );
          yield* syncMetricStreamState({
            name: output.metricStreamName,
            enabled: news.enabled,
          });

          const tags = yield* updateResourceTags({
            id,
            resourceArn: output.metricStreamArn,
            olds: olds.tags,
            news: news.tags,
          });

          yield* session.note(output.metricStreamArn);

          const state = yield* readMetricStream(output.metricStreamName);
          if (!state) {
            return yield* Effect.fail(
              new Error(
                `failed to read updated metric stream '${output.metricStreamName}'`,
              ),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const existing = yield* readMetricStream(output.metricStreamName);
          if (!existing) {
            return;
          }

          yield* retryConcurrent(
            cloudwatch.deleteMetricStream({
              Name: output.metricStreamName,
            }),
          ).pipe(
            Effect.catchTag(
              "InvalidParameterValueException",
              () => Effect.void,
            ),
          );
        }),
      };
    }),
  );
