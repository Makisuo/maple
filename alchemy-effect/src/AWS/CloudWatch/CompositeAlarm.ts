import { Region } from "@distilled.cloud/aws/Region";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import type { AlarmArn } from "./Alarm.ts";
import {
  createName,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type CompositeAlarmName = string;

export interface CompositeAlarmProps extends Omit<
  cloudwatch.PutCompositeAlarmInput,
  "AlarmName" | "Tags"
> {
  /**
   * Name of the composite alarm. If omitted, a unique name is generated.
   */
  name?: CompositeAlarmName;
  /**
   * Optional tags to apply to the composite alarm.
   */
  tags?: Record<string, string>;
}

export interface CompositeAlarm extends Resource<
  "AWS.CloudWatch.CompositeAlarm",
  CompositeAlarmProps,
  {
    alarmName: CompositeAlarmName;
    alarmArn: AlarmArn;
    stateValue: cloudwatch.StateValue | undefined;
    stateReason: string | undefined;
    compositeAlarm: cloudwatch.CompositeAlarm;
    tags: Record<string, string>;
  }
> {}

/**
 * A CloudWatch composite alarm.
 *
 * @section Creating Composite Alarms
 * @example Composite Rule
 * ```typescript
 * const composite = yield* CompositeAlarm("HighSeverity", {
 *   AlarmRule: 'ALARM("HighErrors") OR ALARM("HighLatency")',
 * });
 * ```
 */
export const CompositeAlarm = Resource<CompositeAlarm>(
  "AWS.CloudWatch.CompositeAlarm",
);

export const CompositeAlarmProvider = () =>
  Provider.effect(
    CompositeAlarm,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createAlarmName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const alarmArn = (alarmName: string) =>
        `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}` as AlarmArn;

      const readCompositeAlarm = Effect.fn(function* (alarmName: string) {
        const described = yield* cloudwatch.describeAlarms({
          AlarmNames: [alarmName],
          AlarmTypes: ["CompositeAlarm"],
        });
        const compositeAlarm = described.CompositeAlarms?.find(
          (candidate) => candidate.AlarmName === alarmName,
        );

        if (!compositeAlarm?.AlarmName || !compositeAlarm.AlarmArn) {
          return undefined;
        }

        const tags = yield* readResourceTags(compositeAlarm.AlarmArn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          alarmName: compositeAlarm.AlarmName,
          alarmArn: compositeAlarm.AlarmArn as AlarmArn,
          stateValue: compositeAlarm.StateValue,
          stateReason: compositeAlarm.StateReason,
          compositeAlarm,
          tags,
        };
      });

      return {
        stables: ["alarmName", "alarmArn"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createAlarmName(id, olds);
          const newName = yield* createAlarmName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.alarmName ?? (yield* createAlarmName(id, olds ?? {}));
          return yield* readCompositeAlarm(name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createAlarmName(id, news);
          const existing = yield* readCompositeAlarm(name);

          if (existing) {
            yield* ensureOwnedByAlchemy(
              id,
              name,
              existing.tags,
              "composite alarm",
            );
          }

          yield* retryConcurrent(
            cloudwatch.putCompositeAlarm({
              ...news,
              AlarmName: name,
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: alarmArn(name),
            olds: existing?.tags,
            news: news.tags,
          });

          yield* session.note(alarmArn(name));

          const state = yield* readCompositeAlarm(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read created composite alarm '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* retryConcurrent(
            cloudwatch.putCompositeAlarm({
              ...news,
              AlarmName: output.alarmName,
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceArn: output.alarmArn,
            olds: olds.tags,
            news: news.tags,
          });

          yield* session.note(output.alarmArn);

          const state = yield* readCompositeAlarm(output.alarmName);
          if (!state) {
            return yield* Effect.fail(
              new Error(
                `failed to read updated composite alarm '${output.alarmName}'`,
              ),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrent(
            cloudwatch.deleteAlarms({
              AlarmNames: [output.alarmName],
            }),
          );
        }),
      };
    }),
  );
