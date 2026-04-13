import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";

export interface ScheduleProps {
  /**
   * Schedule name. If omitted, Alchemy generates a deterministic name.
   */
  name?: string;
  /**
   * Optional schedule group. Defaults to the AWS default group.
   */
  groupName?: Input<string>;
  /**
   * Required schedule expression, such as `rate(5 minutes)` or `cron(...)`.
   */
  scheduleExpression: string;
  /**
   * Optional start date.
   */
  startDate?: Date;
  /**
   * Optional end date.
   */
  endDate?: Date;
  /**
   * Optional description.
   */
  description?: string;
  /**
   * Optional timezone for cron or at expressions.
   */
  scheduleExpressionTimezone?: string;
  /**
   * Desired schedule state.
   */
  state?: string;
  /**
   * Optional KMS key ARN.
   */
  kmsKeyArn?: Input<string>;
  /**
   * Scheduler target configuration.
   */
  target: Input<scheduler.Target>;
  /**
   * Flexible time window configuration.
   */
  flexibleTimeWindow?: Input<scheduler.FlexibleTimeWindow>;
  /**
   * Action after a one-time schedule completes.
   */
  actionAfterCompletion?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

/**
 * An EventBridge Scheduler schedule.
 *
 * `Schedule` is the canonical time-based delivery primitive. High-level helpers
 * like `every`, `cron`, and `at` can synthesize the target role and scheduler
 * target configuration on top of this resource.
 *
 * @section Creating Schedules
 * @example Hourly Schedule
 * ```typescript
 * const schedule = yield* Schedule("HourlyJob", {
 *   scheduleExpression: "rate(1 hour)",
 *   target: {
 *     Arn: fn.functionArn,
 *     RoleArn: role.roleArn,
 *   },
 *   flexibleTimeWindow: {
 *     Mode: "OFF",
 *   },
 * });
 * ```
 */
export interface Schedule extends Resource<
  "AWS.Scheduler.Schedule",
  ScheduleProps,
  {
    scheduleArn: string;
    scheduleName: string;
    groupName: string;
    state: string | undefined;
  }
> {}

export const Schedule = Resource<Schedule>("AWS.Scheduler.Schedule");

export const ScheduleProvider = () =>
  Provider.effect(
    Schedule,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleArn", "scheduleName", "groupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }

          if ((olds.groupName ?? "default") !== (news.groupName ?? "default")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleName =
            output?.scheduleName ?? (yield* toName(id, olds));
          const groupName =
            output?.groupName ??
            (olds.groupName as string | undefined) ??
            "default";
          const described = yield* scheduler
            .getSchedule({
              Name: scheduleName,
              GroupName: groupName !== "default" ? groupName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          return {
            scheduleArn: described.Arn,
            scheduleName: described.Name,
            groupName: described.GroupName ?? groupName,
            state: described.State,
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const scheduleName = yield* toName(id, news);
          const groupName = (news.groupName as string | undefined) ?? "default";
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          const created = yield* scheduler
            .createSchedule({
              Name: scheduleName,
              GroupName: groupName !== "default" ? groupName : undefined,
              ScheduleExpression: news.scheduleExpression,
              StartDate: news.startDate,
              EndDate: news.endDate,
              Description: news.description,
              ScheduleExpressionTimezone: news.scheduleExpressionTimezone,
              State: news.state,
              KmsKeyArn: news.kmsKeyArn as string | undefined,
              Target: news.target as scheduler.Target,
              FlexibleTimeWindow: (news.flexibleTimeWindow as
                | scheduler.FlexibleTimeWindow
                | undefined) ?? {
                Mode: "OFF",
              },
              ActionAfterCompletion: news.actionAfterCompletion,
            })
            .pipe(
              Effect.catchTag("ConflictException", () =>
                scheduler
                  .getSchedule({
                    Name: scheduleName,
                    GroupName: groupName !== "default" ? groupName : undefined,
                  })
                  .pipe(
                    Effect.flatMap((existing) =>
                      existing.Arn
                        ? scheduler
                            .listTagsForResource({
                              ResourceArn: existing.Arn,
                            })
                            .pipe(
                              Effect.filterOrFail(
                                ({ Tags }) => hasTags(tags, Tags),
                                () =>
                                  new Error(
                                    `Schedule '${scheduleName}' already exists and is not managed by alchemy`,
                                  ),
                              ),
                              Effect.as({
                                ScheduleArn: existing.Arn,
                              }),
                            )
                        : Effect.fail(
                            new Error(
                              `Schedule '${scheduleName}' already exists but could not be described`,
                            ),
                          ),
                    ),
                  ),
              ),
            );

          if (Object.keys(tags).length > 0) {
            yield* scheduler.tagResource({
              ResourceArn: created.ScheduleArn,
              Tags: createTagsList(tags),
            });
          }

          yield* session.note(created.ScheduleArn);

          return {
            scheduleArn: created.ScheduleArn,
            scheduleName,
            groupName,
            state: news.state,
          };
        }),
        update: Effect.fn(function* ({ id, olds, news, output, session }) {
          yield* scheduler.updateSchedule({
            Name: output.scheduleName,
            GroupName:
              output.groupName !== "default" ? output.groupName : undefined,
            ScheduleExpression: news.scheduleExpression,
            StartDate: news.startDate,
            EndDate: news.endDate,
            Description: news.description,
            ScheduleExpressionTimezone: news.scheduleExpressionTimezone,
            State: news.state,
            KmsKeyArn: news.kmsKeyArn as string | undefined,
            Target: news.target as scheduler.Target,
            FlexibleTimeWindow: (news.flexibleTimeWindow as
              | scheduler.FlexibleTimeWindow
              | undefined) ?? {
              Mode: "OFF",
            },
            ActionAfterCompletion: news.actionAfterCompletion,
          });

          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...olds.tags,
          };
          const newTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* scheduler.untagResource({
              ResourceArn: output.scheduleArn,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            yield* scheduler.tagResource({
              ResourceArn: output.scheduleArn,
              Tags: upsert,
            });
          }

          yield* session.note(output.scheduleArn);
          return {
            ...output,
            state: news.state,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteSchedule({
              Name: output.scheduleName,
              GroupName:
                output.groupName !== "default" ? output.groupName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
