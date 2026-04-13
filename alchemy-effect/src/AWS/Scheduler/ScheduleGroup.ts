import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";

export interface ScheduleGroupProps {
  /**
   * Schedule group name. If omitted, Alchemy generates a deterministic name.
   */
  name?: string;
  /**
   * User-defined tags for the schedule group.
   */
  tags?: Record<string, string>;
}

/**
 * An EventBridge Scheduler schedule group.
 *
 * Schedule groups provide a namespace for schedules so higher-level helpers can
 * organize recurring jobs separately from one-shot or operational schedules.
 *
 * @section Creating Schedule Groups
 * @example Basic Group
 * ```typescript
 * const group = yield* ScheduleGroup("Operations", {
 *   tags: {
 *     domain: "ops",
 *   },
 * });
 * ```
 */
export interface ScheduleGroup extends Resource<
  "AWS.Scheduler.ScheduleGroup",
  ScheduleGroupProps,
  {
    scheduleGroupArn: string;
    scheduleGroupName: string;
    state: string | undefined;
  }
> {}

export const ScheduleGroup = Resource<ScheduleGroup>(
  "AWS.Scheduler.ScheduleGroup",
);

export const ScheduleGroupProvider = () =>
  Provider.effect(
    ScheduleGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleGroupProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleGroupArn", "scheduleGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds)) !==
            (yield* toName(id, news as ScheduleGroupProps))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleGroupName =
            output?.scheduleGroupName ?? (yield* toName(id, olds));
          const described = yield* scheduler
            .getScheduleGroup({
              Name: scheduleGroupName,
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
            scheduleGroupArn: described.Arn,
            scheduleGroupName: described.Name,
            state: described.State,
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const scheduleGroupName = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          const created = yield* scheduler
            .createScheduleGroup({
              Name: scheduleGroupName,
              Tags: createTagsList(tags),
            })
            .pipe(
              Effect.catchTag("ConflictException", () =>
                scheduler.getScheduleGroup({ Name: scheduleGroupName }).pipe(
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
                                  `ScheduleGroup '${scheduleGroupName}' already exists and is not managed by alchemy`,
                                ),
                            ),
                            Effect.as({
                              ScheduleGroupArn: existing.Arn,
                            }),
                          )
                      : Effect.fail(
                          new Error(
                            `ScheduleGroup '${scheduleGroupName}' already exists but could not be described`,
                          ),
                        ),
                  ),
                ),
              ),
            );

          yield* session.note(created.ScheduleGroupArn ?? scheduleGroupName);

          return {
            scheduleGroupArn: created.ScheduleGroupArn ?? scheduleGroupName,
            scheduleGroupName,
            state: undefined,
          };
        }),
        update: Effect.fn(function* ({ id, olds, news, output, session }) {
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
              ResourceArn: output.scheduleGroupArn,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            yield* scheduler.tagResource({
              ResourceArn: output.scheduleGroupArn,
              Tags: upsert,
            });
          }

          yield* session.note(output.scheduleGroupArn);
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteScheduleGroup({
              Name: output.scheduleGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
