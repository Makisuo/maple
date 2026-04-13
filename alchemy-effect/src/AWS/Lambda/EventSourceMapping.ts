import * as lambda from "@distilled.cloud/aws/lambda";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
import { Account } from "../Account.ts";

export type StartingPosition = "TRIM_HORIZON" | "LATEST" | "AT_TIMESTAMP";

export type FunctionResponseType = "ReportBatchItemFailures";

export interface EventSourceMappingProps {
  /**
   * The name or ARN of the Lambda function to invoke.
   */
  functionName: string;
  /**
   * The ARN of the event source (SQS queue, Kinesis stream, DynamoDB stream, etc.).
   */
  eventSourceArn: string;
  /**
   * The maximum number of records in each batch that Lambda pulls and sends to the function.
   *
   * - SQS: default 10, max 10,000 (FIFO max 10)
   * - Kinesis: default 100, max 10,000
   * - DynamoDB Streams: default 100, max 10,000
   */
  batchSize?: number;
  /**
   * The maximum amount of time, in seconds, that Lambda spends gathering records before invoking the function.
   * @default 0
   */
  maximumBatchingWindowInSeconds?: number;
  /**
   * Whether the event source mapping is active.
   * @default true
   */
  enabled?: boolean;
  /**
   * The position in a stream from which to start reading. Required for Kinesis and DynamoDB Streams.
   *
   * - `LATEST` - Read only new records.
   * - `TRIM_HORIZON` - Process all available records.
   * - `AT_TIMESTAMP` - Start reading from a specific time.
   */
  startingPosition?: StartingPosition;
  /**
   * The timestamp to start reading from when `startingPosition` is `AT_TIMESTAMP`.
   */
  startingPositionTimestamp?: Date;
  /**
   * (Kinesis and DynamoDB Streams) The number of batches to process from each shard concurrently.
   * @default 1
   */
  parallelizationFactor?: number;
  /**
   * (Kinesis and DynamoDB Streams) Split the batch in two and retry if the function returns an error.
   * @default false
   */
  bisectBatchOnFunctionError?: boolean;
  /**
   * (Kinesis and DynamoDB Streams) Discard records older than the specified age in seconds.
   * @default -1 (infinite)
   */
  maximumRecordAgeInSeconds?: number;
  /**
   * (Kinesis and DynamoDB Streams) Discard records after the specified number of retries.
   * @default -1 (infinite)
   */
  maximumRetryAttempts?: number;
  /**
   * (Kinesis and DynamoDB Streams) The duration in seconds of a processing window for tumbling windows.
   */
  tumblingWindowInSeconds?: number;
  /**
   * A list of current response type enums applied to the event source mapping.
   * @default ["ReportBatchItemFailures"]
   */
  functionResponseTypes?: FunctionResponseType[];
  /**
   * (SQS) Scaling configuration for the event source.
   */
  scalingConfig?: lambda.ScalingConfig;
  /**
   * (Kinesis and DynamoDB Streams) A destination for records that failed processing.
   */
  destinationConfig?: lambda.DestinationConfig;
  /**
   * Filter criteria to control which records are sent to the function.
   */
  filterCriteria?: lambda.FilterCriteria;
  /**
   * The ARN of an AWS KMS key to encrypt the filter criteria.
   */
  kmsKeyArn?: string;
  /**
   * Metrics configuration for the event source mapping.
   * @default { Metrics: ["EventCount"] }
   */
  metricsConfig?: lambda.EventSourceMappingMetricsConfig;
  /**
   * (SQS, MSK, self-managed Kafka) Provisioned poller configuration.
   */
  provisionedPollerConfig?: lambda.ProvisionedPollerConfig;
  /**
   * (Amazon MSK) Configuration for an Amazon Managed Streaming for Apache Kafka event source.
   */
  amazonManagedKafkaEventSourceConfig?: lambda.AmazonManagedKafkaEventSourceConfig;
  /**
   * (Self-managed Kafka) Configuration for a self-managed Apache Kafka event source.
   */
  selfManagedKafkaEventSourceConfig?: lambda.SelfManagedKafkaEventSourceConfig;
  /**
   * (Self-managed Kafka) The self-managed Apache Kafka cluster for the event source.
   */
  selfManagedEventSource?: lambda.SelfManagedEventSource;
  /**
   * (Amazon MQ, MSK, self-managed Kafka) Source access configuration for VPC, authentication, etc.
   */
  sourceAccessConfigurations?: lambda.SourceAccessConfiguration[];
  /**
   * (Amazon MSK, self-managed Kafka) The Kafka topic name(s).
   */
  topics?: string[];
  /**
   * (Amazon MQ) The name of the Amazon MQ broker destination queue to consume.
   */
  queues?: string[];
  /**
   * (Amazon DocumentDB) Configuration for a DocumentDB event source.
   */
  documentDBEventSourceConfig?: lambda.DocumentDBEventSourceConfig;
  /**
   * (Amazon MSK and self-managed Apache Kafka) The logging configuration for the event source.
   */
  loggingConfig?: lambda.LoggingConfig;
  /**
   * Tags to associate with the event source mapping.
   */
  tags?: Record<string, string>;
}

export interface EventSourceMapping extends Resource<
  "AWS.Lambda.EventSourceMapping",
  EventSourceMappingProps,
  {
    /**
     * The UUID of the event source mapping.
     */
    uuid: string;
    /**
     * The ARN of the event source mapping.
     */
    eventSourceMappingArn: string;
    /**
     * The ARN of the Lambda function.
     */
    functionArn: string;
    /**
     * The current state of the event source mapping.
     */
    state: string;
  }
> {}

export const EventSourceMapping = Resource<EventSourceMapping>(
  "AWS.Lambda.EventSourceMapping",
);

export const EventSourceMappingProvider = () =>
  Provider.effect(
    EventSourceMapping,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const createEventSourceMappingTags = Effect.fn(function* (id: string) {
        const internalTags = yield* createInternalTags(id);
        return {
          ...internalTags,
          "alchemy::id": sanitizeAwsTagValue(internalTags["alchemy::id"]),
        };
      });

      const toCreateRequest = (
        props: EventSourceMappingProps,
        tags: Record<string, string>,
      ): lambda.CreateEventSourceMappingRequest => ({
        FunctionName: props.functionName as string,
        EventSourceArn: props.eventSourceArn as string,
        Enabled: props.enabled ?? true,
        BatchSize: props.batchSize,
        MaximumBatchingWindowInSeconds: props.maximumBatchingWindowInSeconds,
        StartingPosition: props.startingPosition,
        StartingPositionTimestamp: props.startingPositionTimestamp,
        ParallelizationFactor: props.parallelizationFactor,
        BisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
        MaximumRecordAgeInSeconds: props.maximumRecordAgeInSeconds,
        MaximumRetryAttempts: props.maximumRetryAttempts,
        TumblingWindowInSeconds: props.tumblingWindowInSeconds,
        FunctionResponseTypes: props.functionResponseTypes ?? [
          "ReportBatchItemFailures",
        ],
        ScalingConfig: props.scalingConfig,
        DestinationConfig: props.destinationConfig,
        FilterCriteria: props.filterCriteria,
        KMSKeyArn: props.kmsKeyArn,
        MetricsConfig: props.metricsConfig ?? { Metrics: ["EventCount"] },
        ProvisionedPollerConfig: props.provisionedPollerConfig,
        AmazonManagedKafkaEventSourceConfig:
          props.amazonManagedKafkaEventSourceConfig,
        SelfManagedKafkaEventSourceConfig:
          props.selfManagedKafkaEventSourceConfig,
        SelfManagedEventSource: props.selfManagedEventSource,
        SourceAccessConfigurations: props.sourceAccessConfigurations,
        Topics: props.topics,
        Queues: props.queues,
        DocumentDBEventSourceConfig: props.documentDBEventSourceConfig,
        LoggingConfig: props.loggingConfig,
        Tags: tags,
      });

      const toUpdateRequest = (
        uuid: string,
        props: EventSourceMappingProps,
      ): lambda.UpdateEventSourceMappingRequest => ({
        UUID: uuid,
        FunctionName: props.functionName as string,
        Enabled: props.enabled ?? true,
        BatchSize: props.batchSize,
        MaximumBatchingWindowInSeconds: props.maximumBatchingWindowInSeconds,
        BisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
        MaximumRecordAgeInSeconds: props.maximumRecordAgeInSeconds,
        MaximumRetryAttempts: props.maximumRetryAttempts,
        TumblingWindowInSeconds: props.tumblingWindowInSeconds,
        FunctionResponseTypes: props.functionResponseTypes ?? [
          "ReportBatchItemFailures",
        ],
        ScalingConfig: props.scalingConfig,
        DestinationConfig: props.destinationConfig,
        FilterCriteria: props.filterCriteria,
        KMSKeyArn: props.kmsKeyArn,
        MetricsConfig: props.metricsConfig ?? { Metrics: ["EventCount"] },
        ProvisionedPollerConfig: props.provisionedPollerConfig,
        AmazonManagedKafkaEventSourceConfig:
          props.amazonManagedKafkaEventSourceConfig,
        SelfManagedKafkaEventSourceConfig:
          props.selfManagedKafkaEventSourceConfig,
        SourceAccessConfigurations: props.sourceAccessConfigurations,
        DocumentDBEventSourceConfig: props.documentDBEventSourceConfig,
        LoggingConfig: props.loggingConfig,
      });

      const configToAttrs = (
        config: lambda.EventSourceMappingConfiguration,
      ): EventSourceMapping["Attributes"] => ({
        uuid: config.UUID!,
        eventSourceMappingArn: config.EventSourceMappingArn!,
        functionArn: config.FunctionArn!,
        state: config.State!,
      });

      return {
        stables: ["uuid", "eventSourceMappingArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            (news.eventSourceArn as string) !== (olds.eventSourceArn as string)
          ) {
            return { action: "replace" } as const;
          }
          if (news.startingPosition !== olds.startingPosition) {
            return { action: "replace" } as const;
          }
          if (
            news.startingPositionTimestamp?.getTime() !==
            olds.startingPositionTimestamp?.getTime()
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(news.selfManagedEventSource, olds.selfManagedEventSource)
          ) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const expectedInternalTags = yield* createEventSourceMappingTags(id);
          const allTags = { ...expectedInternalTags, ...news.tags };

          const functionName = news.functionName as string;
          const eventSourceArn = news.eventSourceArn as string;

          const config = yield* lambda
            .createEventSourceMapping(toCreateRequest(news, allTags))
            .pipe(
              Effect.catchTags({
                ResourceConflictException: () =>
                  lambda.listEventSourceMappings
                    .pages({
                      FunctionName: functionName,
                    })
                    .pipe(
                      // TODO(sam): maybe process chunks to avoid linear scanning of Event Sources
                      Stream.mapEffect(
                        Effect.fn(function* (page) {
                          const mapping = page.EventSourceMappings?.find(
                            (m) => m.EventSourceArn === eventSourceArn,
                          );

                          if (mapping?.UUID) {
                            const { Tags } = yield* lambda
                              .listTags({
                                Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID}`,
                              })
                              .pipe(retryTransient);

                            if (hasTags(expectedInternalTags, Tags)) {
                              return mapping;
                            }
                          }
                        }),
                      ),
                      Stream.filter((item) => item !== undefined),
                      Stream.runHead,
                      Effect.map(Option.getOrUndefined),
                      Effect.flatMap((mapping) =>
                        mapping
                          ? Effect.succeed(mapping)
                          : Effect.die(
                              new Error(
                                `EventSourceMapping(${id}) not found on function ${functionName}`,
                              ),
                            ),
                      ),
                    ),
              }),
              retryPermissionsPropagation,
              retryTransient,
            );

          yield* session.note(config.EventSourceMappingArn!);

          return configToAttrs(config);
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const config = yield* lambda
            .updateEventSourceMapping(toUpdateRequest(output.uuid, news))
            .pipe(
              Effect.retry({
                while: (e: any) =>
                  e._tag === "ResourceInUseException" ||
                  e._tag === "ResourceConflictException",
                schedule: Schedule.exponential(100).pipe(
                  Schedule.both(Schedule.recurs(20)),
                ),
              }),
              retryPermissionsPropagation,
              retryTransient,
            );

          const internalTags = yield* createEventSourceMappingTags(id);
          const oldTags = { ...internalTags, ...olds.tags };
          const newTags = { ...internalTags, ...news.tags };
          const { removed, upsert } = diffTags(oldTags, newTags);

          const mappingArn = `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${output.uuid}`;

          if (removed.length > 0) {
            yield* lambda
              .untagResource({ Resource: mappingArn, TagKeys: removed })
              .pipe(retryTransient);
          }
          if (upsert.length > 0) {
            const tagsToAdd: Record<string, string> = {};
            for (const { Key, Value } of upsert) {
              tagsToAdd[Key] = Value;
            }
            yield* lambda
              .tagResource({ Resource: mappingArn, Tags: tagsToAdd })
              .pipe(retryTransient);
          }

          yield* session.note(`Updated event source mapping ${output.uuid}`);

          return configToAttrs(config);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* lambda.deleteEventSourceMapping({ UUID: output.uuid }).pipe(
            Effect.retry({
              while: (e: any) =>
                e._tag === "ResourceInUseException" ||
                e._tag === "ResourceConflictException",
              schedule: Schedule.exponential(100).pipe(
                Schedule.both(Schedule.recurs(20)),
              ),
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );

const retryTransient: <A, R, Err>(
  self: Effect.Effect<A, Err, R>,
) => Effect.Effect<A, Err, R> = Effect.retry({
  while: (e: any) =>
    e._tag === "InternalFailure" ||
    e._tag === "RequestExpired" ||
    e._tag === "ServiceException" ||
    e._tag === "ServiceUnavailable" ||
    e._tag === "ThrottlingException" ||
    e._tag === "TooManyRequestsException" ||
    e._tag === "RequestLimitExceeded" ||
    e._tag === "ResourceInUseException",
  schedule: Schedule.exponential(100).pipe(Schedule.both(Schedule.recurs(30))),
});

const retryPermissionsPropagation = Effect.retry({
  while: (e: any) =>
    e._tag === "InvalidParameterValueException" &&
    (e.message?.includes(
      "The function execution role does not have permissions to call",
    ) ||
      e.message?.includes("cannot be assumed by Lambda") ||
      e.message?.includes("Please add Lambda as a Trusted Entity") ||
      e.message?.includes("Cannot access stream") ||
      e.message?.includes("Please ensure the role can perform the GetRecords")),
  schedule: Schedule.exponential(100).pipe(Schedule.both(Schedule.recurs(30))),
}) as <A, R, Err>(self: Effect.Effect<A, Err, R>) => Effect.Effect<A, Err, R>;

const sanitizeAwsTagValue = (value: string) =>
  value.replace(/[^\p{L}\p{Z}\p{N}_.:/=+\-@]/gu, "-");
