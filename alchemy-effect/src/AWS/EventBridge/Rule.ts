import { Region } from "@distilled.cloud/aws/Region";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
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
  hasAlchemyTags,
} from "../../Tags.ts";
import { Account, type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type {
  AppSyncParameters,
  AssignPublicIp,
  AwsVpcConfiguration,
  CapacityProviderStrategyItem,
  HttpParameters,
  InputTransformer,
  KinesisParameters,
  LaunchType,
  NetworkConfiguration,
  PlacementConstraint,
  PlacementConstraintType,
  PlacementStrategy,
  PlacementStrategyType,
  PropagateTags,
  RedshiftDataParameters,
  RetryPolicy,
  RuleState,
  RunCommandParameters,
  RunCommandTarget,
  SageMakerPipelineParameter,
  SageMakerPipelineParameters,
  SqsParameters,
} from "@distilled.cloud/aws/eventbridge";

export type RuleName = string;

export type RuleArn = `arn:aws:events:${RegionID}:${AccountID}:rule/${string}`;

export interface RuleTarget {
  /** Unique identifier for this target within the rule. */
  Id: string;
  /** ARN of the target resource. */
  Arn: string;
  /** ARN of the IAM role to use for this target when the rule is triggered. */
  RoleArn?: string;
  /** Valid JSON text passed to the target. Mutually exclusive with InputPath and InputTransformer. */
  Input?: string;
  /** JSONPath expression to extract from the event and send to the target. Mutually exclusive with Input and InputTransformer. */
  InputPath?: string;
  /** Settings to transform input before sending to the target. Mutually exclusive with Input and InputPath. */
  InputTransformer?: eventbridge.InputTransformer;
  /** Settings for a Kinesis Data Stream target. */
  KinesisParameters?: eventbridge.KinesisParameters;
  /** Parameters for Systems Manager Run Command targets. */
  RunCommandParameters?: eventbridge.RunCommandParameters;
  /** Parameters for ECS task targets. */
  EcsParameters?: RuleTargetEcsParameters;
  /** Parameters for AWS Batch job targets. */
  BatchParameters?: RuleTargetBatchParameters;
  /** Parameters for SQS queue targets (e.g., FIFO message group ID). */
  SqsParameters?: eventbridge.SqsParameters;
  /** Parameters for HTTP endpoint targets (API Gateway, API Destinations). */
  HttpParameters?: eventbridge.HttpParameters;
  /** Parameters for Amazon Redshift Data API targets. */
  RedshiftDataParameters?: eventbridge.RedshiftDataParameters;
  /** Parameters for SageMaker Pipeline targets. */
  SageMakerPipelineParameters?: eventbridge.SageMakerPipelineParameters;
  /** Dead-letter queue configuration for failed event delivery. */
  DeadLetterConfig?: RuleTargetDeadLetterConfig;
  /** Retry policy settings for the target. */
  RetryPolicy?: eventbridge.RetryPolicy;
  /** Parameters for AWS AppSync GraphQL API targets. */
  AppSyncParameters?: eventbridge.AppSyncParameters;
}

/** ECS parameters for a rule target with Input-wrapped ARN fields. */
export interface RuleTargetEcsParameters extends Omit<
  eventbridge.EcsParameters,
  "TaskDefinitionArn"
> {
  /** ARN of the ECS task definition to run. */
  TaskDefinitionArn: string;
}

/** Batch parameters for a rule target with Input-wrapped ARN fields. */
export interface RuleTargetBatchParameters extends Omit<
  eventbridge.BatchParameters,
  "JobDefinition"
> {
  /** ARN or name of the Batch job definition. */
  JobDefinition: string;
}

/** Dead-letter config for a rule target with Input-wrapped ARN. */
export interface RuleTargetDeadLetterConfig {
  /** ARN of the SQS queue used as the dead-letter queue. */
  Arn?: string;
}

export interface RuleProps {
  /**
   * Name of the rule. Must match [\.\-_A-Za-z0-9]+, 1-64 characters.
   * If omitted, a unique name will be generated.
   */
  name?: string;

  /**
   * Description of the rule. Max 512 characters.
   */
  description?: string;

  /**
   * The name or ARN of the event bus to associate with this rule.
   * If omitted, the default event bus is used.
   */
  eventBusName?: string;

  /**
   * The event pattern that triggers this rule. Specified as a JSON-compatible object.
   * A rule must contain at least an eventPattern or scheduleExpression.
   */
  eventPattern?: Record<string, any>;

  /**
   * The scheduling expression (e.g. "rate(5 minutes)", "cron(0 20 * * ? *)").
   * A rule must contain at least an eventPattern or scheduleExpression.
   */
  scheduleExpression?: string;

  /**
   * Whether the rule is enabled or disabled.
   * @default "ENABLED"
   */
  state?: eventbridge.RuleState;

  /**
   * ARN of the IAM role associated with the rule. Required for targets that need
   * IAM roles (e.g. Kinesis, Step Functions, ECS, API Gateway).
   */
  roleArn?: string;

  /**
   * The targets to invoke when this rule is triggered. Maximum 5 targets per rule.
   */
  targets?: RuleTarget[];

  /**
   * Tags to assign to the rule.
   */
  tags?: Record<string, string>;
}

/**
 * An Amazon EventBridge rule that matches events and routes them to targets.
 *
 * @section Creating Rules
 * @example Event Pattern Rule
 * ```typescript
 * const rule = yield* Rule("S3Events", {
 *   eventPattern: {
 *     source: ["aws.s3"],
 *     "detail-type": ["Object Created"],
 *   },
 *   targets: [{
 *     Id: "MyTarget",
 *     Arn: yield* queue.queueArn,
 *   }],
 * });
 * ```
 *
 * @example Scheduled Rule
 * ```typescript
 * const rule = yield* Rule("EveryFiveMinutes", {
 *   scheduleExpression: "rate(5 minutes)",
 *   targets: [{
 *     Id: "LambdaTarget",
 *     Arn: yield* fn.functionArn(),
 *   }],
 * });
 * ```
 *
 * @section Targeting
 * @example Rule with Input Transformer
 * ```typescript
 * const rule = yield* Rule("TransformedEvents", {
 *   eventPattern: {
 *     source: ["aws.ec2"],
 *     "detail-type": ["EC2 Instance State-change Notification"],
 *   },
 *   targets: [{
 *     Id: "SqsTarget",
 *     Arn: yield* queue.queueArn,
 *     InputTransformer: {
 *       InputPathsMap: {
 *         instance: "$.detail.instance-id",
 *         state: "$.detail.state",
 *       },
 *       InputTemplate: '{"instanceId": <instance>, "newState": <state>}',
 *     },
 *   }],
 * });
 * ```
 *
 * @example Rule with Dead Letter Queue
 * ```typescript
 * const rule = yield* Rule("ReliableEvents", {
 *   eventPattern: { source: ["my.app"] },
 *   targets: [{
 *     Id: "Target",
 *     Arn: yield* fn.functionArn(),
 *     DeadLetterConfig: {
 *       Arn: yield* dlq.queueArn,
 *     },
 *     RetryPolicy: {
 *       MaximumRetryAttempts: 3,
 *       MaximumEventAgeInSeconds: 3600,
 *     },
 *   }],
 * });
 * ```
 *
 * @example Rule with ECS Target
 * ```typescript
 * const rule = yield* Rule("EcsSchedule", {
 *   scheduleExpression: "rate(1 hour)",
 *   roleArn: yield* role.roleArn(),
 *   targets: [{
 *     Id: "EcsTask",
 *     Arn: yield* cluster.clusterArn(),
 *     RoleArn: yield* ecsRole.roleArn(),
 *     EcsParameters: {
 *       TaskDefinitionArn: yield* taskDef.taskDefinitionArn(),
 *       TaskCount: 1,
 *       LaunchType: "FARGATE",
 *       NetworkConfiguration: {
 *         awsvpcConfiguration: {
 *           Subnets: ["subnet-abc123"],
 *           AssignPublicIp: "ENABLED",
 *         },
 *       },
 *     },
 *   }],
 * });
 * ```
 */
export interface Rule extends Resource<
  "AWS.EventBridge.Rule",
  RuleProps,
  {
    /** The name of the rule. */
    ruleName: RuleName;
    /** The ARN of the rule. */
    ruleArn: RuleArn;
    /** The event bus associated with the rule. */
    eventBusName: string;
  }
> {}
export const Rule = Resource<Rule>("AWS.EventBridge.Rule");

export const RuleProvider = () =>
  Provider.effect(
    Rule,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createRuleName = (id: string, props: { name?: string } = {}) => {
        if (props.name) {
          return Effect.succeed(props.name);
        }
        return createPhysicalName({
          id,
          maxLength: 64,
        });
      };

      return {
        stables: ["ruleName", "ruleArn", "eventBusName"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createRuleName(id, olds);
          const newName = yield* createRuleName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          const oldBus = (olds.eventBusName as string | undefined) ?? "default";
          const newBus = (news.eventBusName as string | undefined) ?? "default";
          if (oldBus !== newBus) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const ruleName =
            output?.ruleName ?? (yield* createRuleName(id, olds));
          const eventBusName =
            output?.eventBusName ?? olds.eventBusName ?? "default";
          const described = yield* eventbridge
            .describeRule({
              Name: ruleName,
              EventBusName:
                eventBusName !== "default" ? eventBusName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Name) {
            return undefined;
          }

          const resolvedEventBusName = described.EventBusName ?? eventBusName;
          return {
            ruleName: described.Name,
            ruleArn: toRuleArn(
              region,
              accountId,
              resolvedEventBusName,
              described.Name,
            ),
            eventBusName: resolvedEventBusName,
          };
        }),
        create: Effect.fn(function* ({ id, news = {}, session }) {
          yield* validateRuleProps(news);
          const ruleName = yield* createRuleName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = {
            ...internalTags,
            ...(news.tags as Record<string, string> | undefined),
          };
          const eventBusName =
            (news.eventBusName as string | undefined) ?? "default";
          const ruleArn = toRuleArn(region, accountId, eventBusName, ruleName);

          const existing = yield* eventbridge
            .describeRule({
              Name: ruleName,
              EventBusName:
                eventBusName !== "default" ? eventBusName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (existing) {
            const { Tags } = yield* eventbridge.listTagsForResource({
              ResourceARN: existing.Arn ?? ruleArn,
            });

            if (!(yield* hasAlchemyTags(id, Tags ?? []))) {
              return yield* Effect.fail(
                new Error(
                  `Rule '${ruleName}' already exists on event bus '${eventBusName}' and is not managed by alchemy`,
                ),
              );
            }
          }

          const { RuleArn } = yield* eventbridge.putRule({
            Name: ruleName,
            Description: news.description,
            EventBusName: eventBusName !== "default" ? eventBusName : undefined,
            EventPattern: news.eventPattern
              ? JSON.stringify(news.eventPattern)
              : undefined,
            ScheduleExpression: news.scheduleExpression,
            State: news.state ?? "ENABLED",
            RoleArn: news.roleArn as string | undefined,
            Tags: createTagsList(allTags),
          });

          const resolvedTargets =
            (news.targets as Input.Resolve<RuleTarget>[] | undefined) ?? [];
          if (resolvedTargets.length > 0) {
            const response = yield* eventbridge.putTargets({
              Rule: ruleName,
              EventBusName:
                eventBusName !== "default" ? eventBusName : undefined,
              Targets: resolvedTargets.map(toTarget),
            });
            yield* assertPutTargetsSucceeded(response);
          }

          yield* session.note(ruleArn);

          return {
            ruleName,
            ruleArn:
              (RuleArn as RuleArn | undefined) ??
              toRuleArn(region, accountId, eventBusName, ruleName),
            eventBusName,
          };
        }),
        update: Effect.fn(function* ({
          id,
          news = {},
          olds = {},
          output,
          session,
        }) {
          yield* validateRuleProps(news);
          const ruleName = output.ruleName;
          const eventBusName = output.eventBusName;
          const eventBusParam =
            eventBusName !== "default" ? eventBusName : undefined;

          yield* eventbridge.putRule({
            Name: ruleName,
            Description: news.description,
            EventBusName: eventBusParam,
            EventPattern: news.eventPattern
              ? JSON.stringify(news.eventPattern)
              : undefined,
            ScheduleExpression: news.scheduleExpression,
            State: news.state ?? "ENABLED",
            RoleArn: news.roleArn as string | undefined,
          });

          const oldTargetIds = new Set(
            (
              (olds.targets as Input.Resolve<RuleTarget>[] | undefined) ?? []
            ).map((t) => t.Id),
          );
          const newTargetIds = new Set(
            (
              (news.targets as Input.Resolve<RuleTarget>[] | undefined) ?? []
            ).map((t) => t.Id),
          );
          const removedIds = [...oldTargetIds].filter(
            (id) => !newTargetIds.has(id),
          );

          if (removedIds.length > 0) {
            const response = yield* eventbridge
              .removeTargets({
                Rule: ruleName,
                EventBusName: eventBusParam,
                Ids: removedIds,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );

            if (response) {
              yield* assertRemoveTargetsSucceeded(response);
            }
          }

          const resolvedTargets =
            (news.targets as Input.Resolve<RuleTarget>[] | undefined) ?? [];
          if (resolvedTargets.length > 0) {
            const response = yield* eventbridge.putTargets({
              Rule: ruleName,
              EventBusName: eventBusParam,
              Targets: resolvedTargets.map(toTarget),
            });
            yield* assertPutTargetsSucceeded(response);
          }

          const internalTags = yield* createInternalTags(id);
          const oldTags = {
            ...internalTags,
            ...(olds.tags as Record<string, string> | undefined),
          };
          const newTags = {
            ...internalTags,
            ...(news.tags as Record<string, string> | undefined),
          };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* eventbridge.untagResource({
              ResourceARN: output.ruleArn,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            yield* eventbridge.tagResource({
              ResourceARN: output.ruleArn,
              Tags: upsert,
            });
          }

          yield* session.note(output.ruleArn);
          return output;
        }),
        delete: Effect.fn(function* (input) {
          const ruleName = input.output.ruleName;
          const eventBusName = input.output.eventBusName;
          const eventBusParam =
            eventBusName !== "default" ? eventBusName : undefined;

          const { Targets } = yield* eventbridge
            .listTargetsByRule({
              Rule: ruleName,
              EventBusName: eventBusParam,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Targets: undefined }),
              ),
            );

          if (Targets && Targets.length > 0) {
            const response = yield* eventbridge
              .removeTargets({
                Rule: ruleName,
                EventBusName: eventBusParam,
                Ids: Targets.map((t) => t.Id),
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
            if (response) {
              yield* assertRemoveTargetsSucceeded(response);
            }
          }

          yield* eventbridge
            .deleteRule({
              Name: ruleName,
              EventBusName: eventBusParam,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

const toTarget = (target: Input.Resolve<RuleTarget>): eventbridge.Target => ({
  Id: target.Id,
  Arn: target.Arn,
  RoleArn: target.RoleArn,
  Input: target.Input,
  InputPath: target.InputPath,
  InputTransformer: target.InputTransformer,
  KinesisParameters: target.KinesisParameters,
  RunCommandParameters: target.RunCommandParameters,
  EcsParameters: target.EcsParameters
    ? {
        ...target.EcsParameters,
        TaskDefinitionArn: target.EcsParameters.TaskDefinitionArn,
      }
    : undefined,
  BatchParameters: target.BatchParameters
    ? {
        ...target.BatchParameters,
        JobDefinition: target.BatchParameters.JobDefinition,
      }
    : undefined,
  SqsParameters: target.SqsParameters,
  HttpParameters: target.HttpParameters,
  RedshiftDataParameters: target.RedshiftDataParameters,
  SageMakerPipelineParameters: target.SageMakerPipelineParameters,
  DeadLetterConfig: target.DeadLetterConfig
    ? { Arn: target.DeadLetterConfig.Arn }
    : undefined,
  RetryPolicy: target.RetryPolicy,
  AppSyncParameters: target.AppSyncParameters,
});

const toRuleArn = (
  region: RegionID,
  accountId: AccountID,
  eventBusName: string,
  ruleName: string,
): RuleArn =>
  (eventBusName === "default"
    ? `arn:aws:events:${region}:${accountId}:rule/${ruleName}`
    : `arn:aws:events:${region}:${accountId}:rule/${eventBusName}/${ruleName}`) as RuleArn;

const validateRuleProps = Effect.fn(function* (props: RuleProps) {
  if (!props.eventPattern && !props.scheduleExpression) {
    return yield* Effect.fail(
      new Error(
        "EventBridge Rule requires either `eventPattern` or `scheduleExpression`",
      ),
    );
  }
});

const assertPutTargetsSucceeded = Effect.fn(function* (
  response: eventbridge.PutTargetsResponse,
) {
  if ((response.FailedEntryCount ?? 0) > 0) {
    return yield* Effect.fail(
      new Error(
        `Failed to attach EventBridge targets: ${JSON.stringify(response.FailedEntries ?? [])}`,
      ),
    );
  }
});

const assertRemoveTargetsSucceeded = Effect.fn(function* (
  response: eventbridge.RemoveTargetsResponse,
) {
  if ((response.FailedEntryCount ?? 0) > 0) {
    return yield* Effect.fail(
      new Error(
        `Failed to remove EventBridge targets: ${JSON.stringify(response.FailedEntries ?? [])}`,
      ),
    );
  }
});
