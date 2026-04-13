import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type {
  PointInTimeRecoverySpecification,
  TimeToLiveSpecification,
} from "@distilled.cloud/aws/dynamodb";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type * as lambda from "aws-lambda";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { havePropsChanged, isResolved } from "../../Diff.ts";
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
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type TableName = string;

export type TableArn =
  `arn:aws:dynamodb:${RegionID}:${AccountID}:table/${TableName}`;

export type TableRecord<Data> = Omit<lambda.DynamoDBRecord, "dynamodb"> & {
  dynamodb: Omit<lambda.StreamRecord, "NewImage" | "OldImage"> & {
    NewImage?: Data;
    OldImage?: Data;
  };
};

export type TableEvent<Data> = Omit<lambda.DynamoDBStreamEvent, "Records"> & {
  Records: TableRecord<Data>[];
};

export type ScalarAttributeType = "S" | "N" | "B";

export type TableProps = {
  /**
   * Name of the table. If omitted, Alchemy generates a deterministic physical
   * name from the stack, stage, and logical ID.
   */
  tableName?: string;
  /**
   * Partition key attribute name for the table.
   */
  partitionKey: string;
  /**
   * Optional sort key attribute name for the table.
   */
  sortKey?: string;
  /**
   * Attribute definitions used by the primary key and any secondary indexes.
   */
  attributes: Record<string, ScalarAttributeType>;
  localSecondaryIndexes?: DynamoDB.LocalSecondaryIndex[];
  globalSecondaryIndexes?: DynamoDB.GlobalSecondaryIndex[];
  billingMode?: DynamoDB.BillingMode;
  deletionProtectionEnabled?: boolean;
  onDemandThroughput?: DynamoDB.OnDemandThroughput;
  pointInTimeRecoverySpecification?: DynamoDB.PointInTimeRecoverySpecification;
  provisionedThroughput?: DynamoDB.ProvisionedThroughput;
  sseSpecification?: DynamoDB.SSESpecification;
  tags?: Record<string, string>;
  timeToLiveSpecification?: DynamoDB.TimeToLiveSpecification;
  warmThroughput?: DynamoDB.WarmThroughput;
  tableClass?: DynamoDB.TableClass;
};

export type TableBinding = {
  streamSpecification?: DynamoDB.StreamSpecification;
};

export interface Table extends Resource<
  "AWS.DynamoDB.Table",
  TableProps,
  {
    tableId: string;
    tableName: TableName;
    tableArn: TableArn;
    partitionKey: string;
    sortKey: string | undefined;
    latestStreamArn: string | undefined;
    streamSpecification: DynamoDB.StreamSpecification | undefined;
    localSecondaryIndexes:
      | DynamoDB.LocalSecondaryIndexDescription[]
      | undefined;
    globalSecondaryIndexes:
      | DynamoDB.GlobalSecondaryIndexDescription[]
      | undefined;
    pointInTimeRecoveryDescription:
      | DynamoDB.PointInTimeRecoveryDescription
      | undefined;
    tags: Record<string, string> | undefined;
  },
  TableBinding
> {}

/**
 * An Amazon DynamoDB table with optional indexes, PITR, TTL, and stream-aware
 * binding support.
 *
 * `Table` owns the lifecycle of the physical table while the binding contract
 * allows runtime-specific integrations such as Lambda table event sources to
 * request stream configuration without forcing a circular input prop.
 *
 * @section Creating Tables
 * @example Basic Table
 * ```typescript
 * const table = yield* Table("UsersTable", {
 *   partitionKey: "pk",
 *   attributes: {
 *     pk: "S",
 *   },
 * });
 * ```
 *
 * @example Table with Sort Key and TTL
 * ```typescript
 * const table = yield* Table("SessionsTable", {
 *   partitionKey: "userId",
 *   sortKey: "sessionId",
 *   attributes: {
 *     userId: "S",
 *     sessionId: "S",
 *     expiresAt: "N",
 *   },
 *   timeToLiveSpecification: {
 *     Enabled: true,
 *     AttributeName: "expiresAt",
 *   },
 * });
 * ```
 *
 * @section Runtime Operations
 * @example Read an Item
 * ```typescript
 * const getItem = yield* GetItem.bind(table);
 *
 * const response = yield* getItem({
 *   Key: {
 *     pk: { S: "user#123" },
 *   },
 *   ConsistentRead: true,
 * });
 * ```
 */
export const Table = Resource<Table>("AWS.DynamoDB.Table");

export const TableProvider = () =>
  Provider.effect(
    Table,
    Effect.gen(function* () {
      const createTableName = (
        id: string,
        props: Input.ResolveProps<TableProps>,
      ) =>
        Effect.gen(function* () {
          return (
            props.tableName ??
            (yield* createPhysicalName({
              id,
              // see: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TableDescription.html#DDB-Type-TableDescription-TableName
              maxLength: 255,
            }))
          );
        });

      const toKeySchema = (props: Input.ResolveProps<TableProps>) => [
        {
          AttributeName: props.partitionKey,
          KeyType: "HASH" as const,
        },
        ...(props.sortKey
          ? [
              {
                AttributeName: props.sortKey,
                KeyType: "RANGE" as const,
              },
            ]
          : []),
      ];

      const toAttributeDefinitions = (
        attrs: Record<string, ScalarAttributeType>,
      ) =>
        Object.entries(attrs)
          .map(([name, type]) => ({
            AttributeName: name,
            AttributeType: type,
          }))
          .sort((a, b) => a.AttributeName.localeCompare(b.AttributeName));

      const resolveTableIfOwned = (id: string, tableName: string) =>
        // if it already exists, let's see if it contains tags indicating we (this app+stage) owns it
        // that would indicate we are in a partial state and can safely take control
        dynamodb.describeTable({ TableName: tableName }).pipe(
          Effect.flatMap((r) =>
            dynamodb
              .listTagsOfResource({
                // oxlint-disable-next-line no-non-null-asserted-optional-chain
                ResourceArn: r.Table?.TableArn!,
              })
              .pipe(
                Effect.map((tags) => [r, tags.Tags] as const),
                Effect.flatMap(
                  Effect.fn(function* ([r, tags]) {
                    if (hasTags(yield* createInternalTags(id), tags)) {
                      return r.Table!;
                    }
                    return yield* Effect.fail(
                      new Error("Table tags do not match expected values"),
                    );
                  }),
                ),
              ),
          ),
        );

      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const normalizeStreamSpecification = (
        streamSpecification: DynamoDB.StreamSpecification | undefined,
      ) =>
        streamSpecification?.StreamEnabled === true
          ? ({
              StreamEnabled: true,
              StreamViewType: streamSpecification.StreamViewType,
            } satisfies DynamoDB.StreamSpecification)
          : undefined;

      const resolveStreamSpecification = (
        bindings: ReadonlyArray<TableBinding | { data?: TableBinding }>,
      ) =>
        Effect.gen(function* () {
          const requested = bindings
            .flatMap((binding) =>
              (binding as { data?: TableBinding }).data?.streamSpecification
                ?.StreamEnabled === true
                ? [
                    normalizeStreamSpecification(
                      (binding as { data?: TableBinding }).data
                        ?.streamSpecification,
                    ),
                  ]
                : (binding as TableBinding).streamSpecification
                      ?.StreamEnabled === true
                  ? [
                      normalizeStreamSpecification(
                        (binding as TableBinding).streamSpecification,
                      ),
                    ]
                  : [],
            )
            .filter((spec) => spec !== undefined);

          if (requested.length === 0) {
            return undefined;
          }

          const [first, ...rest] = requested;
          if (!first?.StreamViewType) {
            return yield* Effect.fail(new MissingStreamViewType());
          }

          for (const spec of rest) {
            if (spec.StreamViewType !== first.StreamViewType) {
              return yield* Effect.fail(
                new ConflictingStreamViewTypes({
                  requested: requested.map((item) => item.StreamViewType),
                }),
              );
            }
          }

          return first;
        });

      const isRetryableControlPlaneError = (error: { _tag?: string }) =>
        error._tag === "InternalServerError" ||
        error._tag === "LimitExceededException" ||
        error._tag === "ResourceInUseException" ||
        error._tag === "ResourceNotFoundException";

      const waitForControlPlaneConvergence = Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(120)),
      );

      const waitForTableActivationConvergence = Schedule.fixed(
        "10 seconds",
      ).pipe(Schedule.both(Schedule.recurs(180)));

      const waitForGlobalSecondaryIndexesConvergence = Schedule.fixed(
        "10 seconds",
      ).pipe(Schedule.both(Schedule.recurs(180)));

      const waitForDeletionConvergence = Schedule.fixed("1 second").pipe(
        Schedule.both(Schedule.recurs(90)),
      );

      const formatPollingElapsed = (elapsedSeconds: number) =>
        `${elapsedSeconds}s elapsed`;

      const formatGlobalSecondaryIndexStatuses = (
        indexes:
          | readonly DynamoDB.GlobalSecondaryIndexDescription[]
          | undefined,
      ) =>
        JSON.stringify(
          (indexes ?? []).map((index) => ({
            name: index.IndexName,
            status: index.IndexStatus,
            backfilling: index.Backfilling,
          })),
        );

      const updateTimeToLive = (
        tableName: string,
        timeToLiveSpecification: TimeToLiveSpecification,
      ) =>
        dynamodb
          .updateTimeToLive({
            TableName: tableName,
            TimeToLiveSpecification: timeToLiveSpecification!,
          })
          .pipe(
            Effect.retry({
              while: isRetryableControlPlaneError,
              schedule: Schedule.exponential(100).pipe(
                Schedule.both(Schedule.recurs(30)),
              ),
            }),
          );

      const updateContinuousBackups = (
        tableName: string,
        pointInTimeRecoverySpecification: PointInTimeRecoverySpecification,
      ) =>
        dynamodb
          .updateContinuousBackups({
            TableName: tableName,
            PointInTimeRecoverySpecification: pointInTimeRecoverySpecification,
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "ContinuousBackupsUnavailableException" ||
                isRetryableControlPlaneError(e),
              schedule: Schedule.exponential(250).pipe(
                Schedule.both(Schedule.recurs(30)),
              ),
            }),
          );

      const waitForTableActive = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) => {
        let elapsedSeconds = 0;
        let progressMessage = `DynamoDB Table provider: waiting for table ${tableName} to become ACTIVE`;

        return Effect.gen(function* () {
          const response = yield* dynamodb.describeTable({
            TableName: tableName,
          });
          if (response.Table?.TableStatus !== "ACTIVE") {
            progressMessage = `DynamoDB Table provider: table ${tableName} not active yet (status=${response.Table?.TableStatus ?? "undefined"} gsiStatuses=${formatGlobalSecondaryIndexStatuses(response.Table?.GlobalSecondaryIndexes)})`;
            return yield* Effect.fail(new TableNotActive());
          }
          yield* session.note(
            `DynamoDB Table provider: table ${tableName} is ACTIVE (${formatPollingElapsed(elapsedSeconds)})`,
          );
          return response.Table;
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "TableNotActive" ||
              isRetryableControlPlaneError(error),
            schedule: waitForTableActivationConvergence.pipe(
              Schedule.tapOutput(([, attempt]) => {
                elapsedSeconds = (attempt + 1) * 10;
                return session.note(
                  `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const waitForGlobalSecondaryIndexesStable = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
        expectedIndexNames: readonly string[],
      ) => {
        let elapsedSeconds = 0;
        let progressMessage = `DynamoDB Table provider: waiting for GSIs on ${tableName} to stabilize`;

        return Effect.gen(function* () {
          const response = yield* dynamodb.describeTable({
            TableName: tableName,
          });
          const table = response.Table;
          const actualIndexNames = [...(table?.GlobalSecondaryIndexes ?? [])]
            .map((index) => index.IndexName!)
            .sort();
          const expected = [...expectedIndexNames].sort();
          const allActive = (table?.GlobalSecondaryIndexes ?? []).every(
            (index) => index.IndexStatus === "ACTIVE",
          );

          if (
            JSON.stringify(actualIndexNames) !== JSON.stringify(expected) ||
            !allActive
          ) {
            progressMessage = `DynamoDB Table provider: GSIs for ${tableName} not stable yet (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actualIndexNames)} statuses=${JSON.stringify((table?.GlobalSecondaryIndexes ?? []).map((index) => ({ name: index.IndexName, status: index.IndexStatus })))} tableStatus=${table?.TableStatus ?? "undefined"})`;
            return yield* Effect.fail(new TableIndexesNotStable());
          }

          yield* session.note(
            `DynamoDB Table provider: GSIs for ${tableName} stabilized (${JSON.stringify(actualIndexNames)}) (${formatPollingElapsed(elapsedSeconds)})`,
          );
          return table;
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "TableIndexesNotStable" ||
              isRetryableControlPlaneError(error),
            schedule: waitForGlobalSecondaryIndexesConvergence.pipe(
              Schedule.tapOutput(([, attempt]) => {
                elapsedSeconds = (attempt + 1) * 10;
                return session.note(
                  `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const waitForTableDeleted = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) => {
        let elapsedSeconds = 0;
        let progressMessage = `DynamoDB Table provider: waiting for deletion of ${tableName}`;

        return Effect.gen(function* () {
          const response = yield* dynamodb.describeTable({
            TableName: tableName,
          });
          progressMessage = `DynamoDB Table provider: table ${tableName} still deleting (status=${response.Table?.TableStatus ?? "undefined"})`;
          return yield* Effect.fail(new TableStillDeleting());
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => {
            return session.note(
              `DynamoDB Table provider: table ${tableName} deletion confirmed (${formatPollingElapsed(elapsedSeconds)})`,
            );
          }),
          Effect.retry({
            while: (error) =>
              error._tag === "TableStillDeleting" ||
              isRetryableControlPlaneError(error),
            schedule: waitForDeletionConvergence.pipe(
              Schedule.tapOutput(([, attempt]) => {
                elapsedSeconds = attempt + 1;
                return session.note(
                  `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                );
              }),
            ),
          }),
        );
      };

      const deleteGlobalSecondaryIndexes = (
        session: {
          note: (message: string) => Effect.Effect<void, never, never>;
        },
        tableName: string,
      ) =>
        Effect.gen(function* () {
          const response = yield* dynamodb
            .describeTable({
              TableName: tableName,
            })
            .pipe(
              Effect.retry({
                while: isRetryableControlPlaneError,
                schedule: waitForControlPlaneConvergence,
              }),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Table: undefined }),
              ),
            );

          const indexNames = [...(response.Table?.GlobalSecondaryIndexes ?? [])]
            .map((index) => index.IndexName!)
            .sort();

          if (indexNames.length === 0) {
            yield* session.note(
              `DynamoDB Table provider: no GSIs remain on ${tableName}; retrying table deletion`,
            );
            return;
          }

          yield* session.note(
            `DynamoDB Table provider: deleting GSIs before deleting table ${tableName} (${indexNames.join(", ")})`,
          );

          yield* waitForGlobalSecondaryIndexesStable(
            session,
            tableName,
            indexNames,
          );

          const remainingIndexNames = [...indexNames];
          for (const indexName of indexNames) {
            let elapsedSeconds = 0;
            let progressMessage = `DynamoDB Table provider: waiting to delete GSI ${indexName} from ${tableName}`;

            yield* session.note(
              `DynamoDB Table provider: deleting GSI ${indexName} from ${tableName}`,
            );

            yield* dynamodb
              .updateTable({
                TableName: tableName,
                GlobalSecondaryIndexUpdates: [
                  {
                    Delete: {
                      IndexName: indexName,
                    },
                  },
                ],
              })
              .pipe(
                Effect.timeout(1000),
                Effect.tap(() =>
                  session.note(
                    `DynamoDB Table provider: delete accepted for GSI ${indexName} on ${tableName} (${formatPollingElapsed(elapsedSeconds)})`,
                  ),
                ),
                Effect.retry({
                  while: (error) => {
                    if (error._tag === "ResourceInUseException") {
                      progressMessage = `DynamoDB Table provider: delete for GSI ${indexName} on ${tableName} is blocked while the table or indexes are still transitioning`;
                      return true;
                    }
                    if (error._tag === "TimeoutError") {
                      progressMessage = `DynamoDB Table provider: delete for GSI ${indexName} on ${tableName} timed out`;
                      return true;
                    }
                    if (
                      error._tag === "InternalServerError" ||
                      error._tag === "LimitExceededException"
                    ) {
                      progressMessage = `DynamoDB Table provider: delete for GSI ${indexName} on ${tableName} hit ${error._tag}`;
                      return true;
                    }
                    return false;
                  },
                  schedule: waitForGlobalSecondaryIndexesConvergence.pipe(
                    Schedule.tapOutput(([, attempt]) => {
                      elapsedSeconds = (attempt + 1) * 10;
                      return session.note(
                        `${progressMessage} (${formatPollingElapsed(elapsedSeconds)})`,
                      );
                    }),
                  ),
                }),
              );

            remainingIndexNames.splice(
              remainingIndexNames.indexOf(indexName),
              1,
            );

            yield* waitForGlobalSecondaryIndexesStable(
              session,
              tableName,
              remainingIndexNames,
            );
          }
        });

      const readTableState = (tableName: string) =>
        Effect.gen(function* () {
          const response = yield* dynamodb
            .describeTable({
              TableName: tableName,
            })
            .pipe(
              Effect.retry({
                while: isRetryableControlPlaneError,
                schedule: Schedule.exponential(250).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
            );
          const table = response.Table;
          if (!table?.TableArn) {
            return yield* Effect.fail(
              new Error(`Table ${tableName} not found`),
            );
          }

          const [tagsResult, continuousBackupsResult] = yield* Effect.all([
            dynamodb
              .listTagsOfResource({
                ResourceArn: table.TableArn,
              })
              .pipe(
                Effect.retry({
                  while: isRetryableControlPlaneError,
                  schedule: Schedule.exponential(250).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
              ),
            dynamodb
              .describeContinuousBackups({
                TableName: tableName,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "InternalServerError",
                  schedule: Schedule.exponential(250).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
                Effect.catchTag("TableNotFoundException", () =>
                  Effect.succeed({ ContinuousBackupsDescription: undefined }),
                ),
              ),
          ]);

          return {
            table,
            tags: Object.fromEntries(
              (tagsResult.Tags ?? []).map((tag) => [tag.Key!, tag.Value!]),
            ) as Record<string, string>,
            pointInTimeRecoveryDescription:
              continuousBackupsResult.ContinuousBackupsDescription
                ?.PointInTimeRecoveryDescription,
          };
        }).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const toAttrs = (state: {
        table: DynamoDB.TableDescription;
        tags: Record<string, string>;
        pointInTimeRecoveryDescription:
          | DynamoDB.PointInTimeRecoveryDescription
          | undefined;
      }) => ({
        tableId: state.table.TableId!,
        tableName: state.table.TableName!,
        tableArn: state.table.TableArn! as TableArn,
        partitionKey:
          state.table.KeySchema?.find((key) => key.KeyType === "HASH")
            ?.AttributeName ?? "",
        sortKey: state.table.KeySchema?.find((key) => key.KeyType === "RANGE")
          ?.AttributeName,
        latestStreamArn: state.table.LatestStreamArn,
        streamSpecification: state.table.StreamSpecification,
        localSecondaryIndexes: state.table.LocalSecondaryIndexes,
        globalSecondaryIndexes: state.table.GlobalSecondaryIndexes,
        pointInTimeRecoveryDescription: state.pointInTimeRecoveryDescription,
        tags: state.tags,
      });

      const indexesByName = <T extends { IndexName?: string }>(
        indexes: readonly T[] | undefined,
      ) =>
        Object.fromEntries(
          (indexes ?? []).map((index) => [index.IndexName!, index]),
        ) as Record<string, T>;

      const sortKeySchema = (
        keySchema: readonly DynamoDB.KeySchemaElement[] | undefined,
      ) =>
        [...(keySchema ?? [])].sort((a, b) =>
          `${a.KeyType}:${a.AttributeName}`.localeCompare(
            `${b.KeyType}:${b.AttributeName}`,
          ),
        );

      const normalizeProjection = (
        projection: DynamoDB.Projection | undefined,
      ) => ({
        ...projection,
        NonKeyAttributes: [...(projection?.NonKeyAttributes ?? [])].sort(),
      });

      const isSameGsiDefinition = (
        left: DynamoDB.GlobalSecondaryIndex,
        right: DynamoDB.GlobalSecondaryIndex,
      ) =>
        JSON.stringify(sortKeySchema(left.KeySchema)) ===
          JSON.stringify(sortKeySchema(right.KeySchema)) &&
        JSON.stringify(normalizeProjection(left.Projection)) ===
          JSON.stringify(normalizeProjection(right.Projection));

      const diffGlobalSecondaryIndexes = (
        olds: readonly DynamoDB.GlobalSecondaryIndex[] | undefined,
        news: readonly DynamoDB.GlobalSecondaryIndex[] | undefined,
      ) => {
        const oldByName = indexesByName(olds);
        const newByName = indexesByName(news);
        const updates: DynamoDB.GlobalSecondaryIndexUpdate[] = [];
        let requiresReplacement = false;

        for (const [indexName, oldIndex] of Object.entries(oldByName)) {
          const newIndex = newByName[indexName];
          if (!newIndex) {
            updates.push({
              Delete: {
                IndexName: indexName,
              },
            });
            continue;
          }

          if (!isSameGsiDefinition(oldIndex, newIndex)) {
            requiresReplacement = true;
            continue;
          }

          if (
            JSON.stringify(oldIndex.ProvisionedThroughput) !==
              JSON.stringify(newIndex.ProvisionedThroughput) ||
            JSON.stringify(oldIndex.OnDemandThroughput) !==
              JSON.stringify(newIndex.OnDemandThroughput) ||
            JSON.stringify(oldIndex.WarmThroughput) !==
              JSON.stringify(newIndex.WarmThroughput)
          ) {
            updates.push({
              Update: {
                IndexName: indexName,
                ProvisionedThroughput: newIndex.ProvisionedThroughput,
                OnDemandThroughput: newIndex.OnDemandThroughput,
                WarmThroughput: newIndex.WarmThroughput,
              },
            });
          }
        }

        for (const [indexName, newIndex] of Object.entries(newByName)) {
          if (!oldByName[indexName]) {
            updates.push({
              Create: {
                IndexName: indexName,
                KeySchema: newIndex.KeySchema,
                Projection: newIndex.Projection,
                ProvisionedThroughput: newIndex.ProvisionedThroughput,
                OnDemandThroughput: newIndex.OnDemandThroughput,
                WarmThroughput: newIndex.WarmThroughput,
              },
            });
          }
        }

        return {
          updates,
          requiresReplacement,
        };
      };

      return Table.Provider.of({
        stables: ["tableName", "tableId", "tableArn"],
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const state = yield* readTableState(output.tableName);
          if (!state) return undefined;
          return toAttrs(state);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            // TODO(sam): if the name is hard-coded, REPLACE is impossible - we need a suffix
            news.tableName !== olds.tableName ||
            olds.partitionKey !== news.partitionKey ||
            olds.sortKey !== news.sortKey
          ) {
            return { action: "replace" } as const;
          }
          for (const [name, type] of Object.entries(olds.attributes)) {
            if (news.attributes[name] !== type) {
              return { action: "replace" } as const;
            }
          }
          if (
            havePropsChanged(
              { localSecondaryIndexes: olds.localSecondaryIndexes ?? [] },
              { localSecondaryIndexes: news.localSecondaryIndexes ?? [] },
            )
          ) {
            return { action: "replace" } as const;
          }
          const { requiresReplacement } = diffGlobalSecondaryIndexes(
            olds.globalSecondaryIndexes,
            news.globalSecondaryIndexes,
          );
          if (requiresReplacement) {
            return { action: "replace" } as const;
          }
          // TODO(sam):
          // Replacements:
          // 1. if you change ImportSourceSpecification
        }),

        create: Effect.fn(function* ({ id, news, session, bindings }) {
          const tableName = yield* createTableName(id, news);
          const allTags = yield* createTags(id, news.tags);
          const streamSpecification =
            yield* resolveStreamSpecification(bindings);
          yield* session.note(
            `Table ${tableName}: resolved stream specification ${JSON.stringify(streamSpecification)}`,
          );

          yield* dynamodb
            .createTable({
              TableName: tableName,
              TableClass: news.tableClass,
              KeySchema: toKeySchema(news),
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              LocalSecondaryIndexes: news.localSecondaryIndexes,
              GlobalSecondaryIndexes: news.globalSecondaryIndexes,
              BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
              SSESpecification: news.sseSpecification,
              StreamSpecification: streamSpecification,
              WarmThroughput: news.warmThroughput,
              DeletionProtectionEnabled: news.deletionProtectionEnabled,
              OnDemandThroughput: news.onDemandThroughput,
              ProvisionedThroughput: news.provisionedThroughput,
              Tags: createTagsList(allTags),
            })
            .pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "LimitExceededException" ||
                  e._tag === "InternalServerError",
                schedule: Schedule.exponential(100),
              }),
              Effect.catchTag("ResourceInUseException", () =>
                resolveTableIfOwned(id, tableName),
              ),
            );

          yield* waitForTableActive(session, tableName);

          if (news.pointInTimeRecoverySpecification) {
            yield* updateContinuousBackups(
              tableName,
              news.pointInTimeRecoverySpecification,
            );
          }

          if (news.timeToLiveSpecification) {
            yield* updateTimeToLive(tableName, news.timeToLiveSpecification);
          }

          if ((news.globalSecondaryIndexes?.length ?? 0) > 0) {
            yield* waitForGlobalSecondaryIndexesStable(
              session,
              tableName,
              news.globalSecondaryIndexes?.map((index) => index.IndexName) ??
                [],
            );
          }

          const state = yield* readTableState(tableName);
          if (!state) {
            return yield* Effect.fail(
              new Error(`Failed to read created table ${tableName}`),
            );
          }

          yield* session.note(state.table.TableArn!);

          return {
            ...toAttrs(state),
            tags: allTags,
          };
        }),

        update: Effect.fn(function* ({
          id,
          output,
          news,
          olds,
          session,
          bindings,
        }) {
          const desiredStreamSpecification =
            yield* resolveStreamSpecification(bindings);
          const currentStreamSpecification = normalizeStreamSpecification(
            output.streamSpecification,
          );
          yield* session.note(
            `Table ${output.tableName}: current stream=${JSON.stringify(currentStreamSpecification)} desired stream=${JSON.stringify(desiredStreamSpecification)}`,
          );
          const streamViewTypeChanged =
            currentStreamSpecification?.StreamEnabled === true &&
            desiredStreamSpecification?.StreamEnabled === true &&
            currentStreamSpecification.StreamViewType !==
              desiredStreamSpecification.StreamViewType;

          if (streamViewTypeChanged) {
            yield* dynamodb.updateTable({
              TableName: output.tableName,
              StreamSpecification: {
                StreamEnabled: false,
              },
            });
            yield* waitForTableActive(session, output.tableName);
          }

          const { updates: globalSecondaryIndexUpdates } =
            diffGlobalSecondaryIndexes(
              olds.globalSecondaryIndexes,
              news.globalSecondaryIndexes,
            );

          const hasBaseUpdate = havePropsChanged(
            {
              tableClass: olds.tableClass,
              attributes: olds.attributes,
              billingMode: olds.billingMode ?? "PAY_PER_REQUEST",
              sseSpecification: olds.sseSpecification,
              warmThroughput: olds.warmThroughput,
              deletionProtectionEnabled: olds.deletionProtectionEnabled,
              onDemandThroughput: olds.onDemandThroughput,
              provisionedThroughput: olds.provisionedThroughput,
            },
            {
              tableClass: news.tableClass,
              attributes: news.attributes,
              billingMode: news.billingMode ?? "PAY_PER_REQUEST",
              sseSpecification: news.sseSpecification,
              warmThroughput: news.warmThroughput,
              deletionProtectionEnabled: news.deletionProtectionEnabled,
              onDemandThroughput: news.onDemandThroughput,
              provisionedThroughput: news.provisionedThroughput,
            },
          );

          if (hasBaseUpdate) {
            yield* dynamodb.updateTable({
              TableName: output.tableName,
              TableClass: news.tableClass,
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              BillingMode: news.billingMode ?? "PAY_PER_REQUEST",
              SSESpecification: news.sseSpecification,
              WarmThroughput: news.warmThroughput,
              DeletionProtectionEnabled: news.deletionProtectionEnabled,
              OnDemandThroughput: news.onDemandThroughput,
              ProvisionedThroughput: news.provisionedThroughput,
            });
            yield* waitForTableActive(session, output.tableName);
          }

          if (
            havePropsChanged(
              { streamSpecification: currentStreamSpecification },
              { streamSpecification: desiredStreamSpecification },
            )
          ) {
            yield* session.note(
              `Table ${output.tableName}: updating stream configuration`,
            );
            yield* dynamodb.updateTable({
              TableName: output.tableName,
              StreamSpecification: desiredStreamSpecification ?? {
                StreamEnabled: false,
              },
            });
            yield* waitForTableActive(session, output.tableName);
          }

          for (const globalSecondaryIndexUpdate of globalSecondaryIndexUpdates) {
            const action = globalSecondaryIndexUpdate.Create
              ? `create ${globalSecondaryIndexUpdate.Create.IndexName}`
              : globalSecondaryIndexUpdate.Update
                ? `update ${globalSecondaryIndexUpdate.Update.IndexName}`
                : `delete ${globalSecondaryIndexUpdate.Delete!.IndexName}`;
            yield* session.note(
              `Table ${output.tableName}: applying GSI update (${action})`,
            );
            yield* dynamodb.updateTable({
              TableName: output.tableName,
              AttributeDefinitions: toAttributeDefinitions(news.attributes),
              GlobalSecondaryIndexUpdates: [globalSecondaryIndexUpdate],
            });
            yield* waitForTableActive(session, output.tableName);
          }

          if (globalSecondaryIndexUpdates.length > 0) {
            yield* session.note(
              `Table ${output.tableName}: waiting for GSIs to stabilize (${(news.globalSecondaryIndexes?.map((index) => index.IndexName) ?? []).join(", ") || "none"})`,
            );
            yield* waitForGlobalSecondaryIndexesStable(
              session,
              output.tableName,
              news.globalSecondaryIndexes?.map((index) => index.IndexName) ??
                [],
            );
            yield* session.note(`Table ${output.tableName}: GSIs stabilized`);
          }

          if (
            news.timeToLiveSpecification &&
            (news.timeToLiveSpecification.AttributeName !==
              olds.timeToLiveSpecification?.AttributeName ||
              news.timeToLiveSpecification?.Enabled !==
                olds.timeToLiveSpecification?.Enabled)
          ) {
            // TODO(sam): can this run in parallel?
            yield* updateTimeToLive(
              output.tableName,
              news.timeToLiveSpecification,
            );
          }

          if (
            JSON.stringify(news.pointInTimeRecoverySpecification) !==
            JSON.stringify(olds.pointInTimeRecoverySpecification)
          ) {
            yield* updateContinuousBackups(output.tableName, {
              PointInTimeRecoveryEnabled:
                news.pointInTimeRecoverySpecification
                  ?.PointInTimeRecoveryEnabled ?? false,
              RecoveryPeriodInDays:
                news.pointInTimeRecoverySpecification?.RecoveryPeriodInDays,
            });
          }

          const oldTags = yield* createTags(id, olds.tags);
          const newTags = yield* createTags(id, news.tags);
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* dynamodb.untagResource({
              ResourceArn: output.tableArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* dynamodb.tagResource({
              ResourceArn: output.tableArn,
              Tags: upsert,
            });
          }

          const state = yield* readTableState(output.tableName);
          if (!state) {
            return yield* Effect.fail(
              new Error(`Failed to read updated table ${output.tableName}`),
            );
          }

          return {
            ...toAttrs(state),
            tags: newTags,
          };
        }),

        delete: Effect.fn(function* ({ output, session }) {
          let deleteAttempt = 0;

          while (true) {
            deleteAttempt += 1;
            yield* session.note(
              `Table ${output.tableName}: deleting (attempt ${deleteAttempt})`,
            );

            const deleteResult = yield* dynamodb
              .deleteTable({
                TableName: output.tableName,
              })
              .pipe(
                Effect.timeout(1000),
                Effect.as("accepted" as const),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed("already-deleted" as const),
                ),
                Effect.catchTag("ResourceInUseException", () =>
                  Effect.succeed("delete-gsis-first" as const),
                ),
                Effect.retry({
                  while: (error) =>
                    error._tag === "InternalServerError" ||
                    error._tag === "TimeoutError",
                  schedule: waitForDeletionConvergence.pipe(
                    Schedule.tapOutput(([, attempt]) =>
                      session.note(
                        `DynamoDB Table provider: deleteTable transient failure for ${output.tableName} on attempt ${deleteAttempt} (${formatPollingElapsed(attempt + 1)})`,
                      ),
                    ),
                  ),
                }),
              );

            if (deleteResult === "accepted") {
              yield* session.note(
                `DynamoDB Table provider: deleteTable accepted for ${output.tableName}`,
              );
              break;
            }

            if (deleteResult === "already-deleted") {
              yield* session.note(
                `DynamoDB Table provider: table ${output.tableName} already deleted`,
              );
              return;
            }

            yield* session.note(
              `DynamoDB Table provider: deleteTable blocked for ${output.tableName}; deleting GSIs first`,
            );
            yield* deleteGlobalSecondaryIndexes(session, output.tableName);
            yield* waitForGlobalSecondaryIndexesStable(
              session,
              output.tableName,
              [],
            );
            yield* waitForTableActive(session, output.tableName);
          }

          yield* session.note(
            `Table ${output.tableName}: waiting for deletion`,
          );
          yield* waitForTableDeleted(session, output.tableName);
        }),
      });
    }),
  );

class TableNotActive extends Data.TaggedError("TableNotActive") {}

class TableIndexesNotStable extends Data.TaggedError("TableIndexesNotStable") {}

class TableStillDeleting extends Data.TaggedError("TableStillDeleting") {}

class MissingStreamViewType extends Data.TaggedError("MissingStreamViewType") {}

class ConflictingStreamViewTypes extends Data.TaggedError(
  "ConflictingStreamViewTypes",
)<{
  requested: readonly (DynamoDB.StreamViewType | undefined)[];
}> {}
