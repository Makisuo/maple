import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import { Account } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type LogGroupName = string;
export type LogGroupArn =
  `arn:aws:logs:${RegionID}:${AccountID}:log-group:${LogGroupName}`;

export interface LogGroupProps {
  /**
   * Name of the log group. If omitted, a unique name is generated.
   */
  logGroupName?: string;
  /**
   * Retention in days. If omitted, CloudWatch keeps logs indefinitely.
   */
  retentionInDays?: number;
  /**
   * Optional KMS key identifier used to encrypt the log group.
   */
  kmsKeyId?: string;
  /**
   * User-defined tags to apply to the log group.
   */
  tags?: Record<string, string>;
}

export interface LogGroup extends Resource<
  "AWS.Logs.LogGroup",
  LogGroupProps,
  {
    logGroupName: LogGroupName;
    logGroupArn: LogGroupArn;
    retentionInDays?: number;
    kmsKeyId?: string;
    tags: Record<string, string>;
  }
> {}

/**
 * A CloudWatch Logs log group.
 *
 * @section Creating Log Groups
 * @example ECS Task Log Group
 * ```typescript
 * const logs = yield* LogGroup("TaskLogs", {
 *   retentionInDays: 7,
 * });
 * ```
 */
export const LogGroup = Resource<LogGroup>("AWS.Logs.LogGroup");

export const LogGroupProvider = () =>
  Provider.effect(
    LogGroup,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const toLogGroupName = (
        id: string,
        props: { logGroupName?: string } = {},
      ) =>
        props.logGroupName
          ? Effect.succeed(props.logGroupName)
          : createPhysicalName({ id, maxLength: 512 });

      return {
        stables: ["logGroupArn", "logGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toLogGroupName(id, olds ?? {})) !==
            (yield* toLogGroupName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const logGroupName =
            output?.logGroupName ?? (yield* toLogGroupName(id, olds ?? {}));
          const described = yield* logs.describeLogGroups({
            logGroupNamePrefix: logGroupName,
            limit: 1,
          });
          const match = (described.logGroups ?? []).find(
            (group) => group.logGroupName === logGroupName,
          );
          if (!match?.arn) {
            return undefined;
          }
          return {
            logGroupName,
            logGroupArn: match.arn as LogGroupArn,
            retentionInDays: match.retentionInDays,
            kmsKeyId: match.kmsKeyId,
            tags: output?.tags ?? {},
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const logGroupName = yield* toLogGroupName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          yield* logs
            .createLogGroup({
              logGroupName,
              kmsKeyId: news.kmsKeyId,
              tags,
            })
            .pipe(
              Effect.catchTag(
                "ResourceAlreadyExistsException",
                () => Effect.void,
              ),
            );

          if (news.retentionInDays !== undefined) {
            yield* logs.putRetentionPolicy({
              logGroupName,
              retentionInDays: news.retentionInDays,
            });
          }

          const arn =
            `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}` as LogGroupArn;
          yield* session.note(arn);

          return {
            logGroupName,
            logGroupArn: arn,
            retentionInDays: news.retentionInDays,
            kmsKeyId: news.kmsKeyId,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          if (news.retentionInDays !== olds.retentionInDays) {
            if (news.retentionInDays === undefined) {
              yield* logs
                .deleteRetentionPolicy({
                  logGroupName: output.logGroupName,
                })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
            } else {
              yield* logs.putRetentionPolicy({
                logGroupName: output.logGroupName,
                retentionInDays: news.retentionInDays,
              });
            }
          }

          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...olds.tags,
          };
          const newTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const { removed, upsert } = diffTags(oldTags, newTags);
          if (upsert.length > 0) {
            yield* logs.tagResource({
              resourceArn: output.logGroupArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* logs.untagResource({
              resourceArn: output.logGroupArn,
              tagKeys: removed,
            });
          }

          yield* session.note(output.logGroupArn);
          return {
            ...output,
            retentionInDays: news.retentionInDays,
            kmsKeyId: news.kmsKeyId,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteLogGroup({
              logGroupName: output.logGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
