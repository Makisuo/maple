import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBInstanceProps {
  /**
   * Instance identifier. If omitted, Alchemy generates one.
   */
  dbInstanceIdentifier?: string;
  /**
   * Aurora cluster the instance belongs to.
   */
  dbClusterIdentifier?: string;
  /**
   * Instance class such as `db.serverless`.
   */
  dbInstanceClass: string;
  /**
   * Database engine, usually matching the cluster engine.
   */
  engine: string;
  /**
   * Optional engine version.
   */
  engineVersion?: string;
  /**
   * Optional DB subnet group.
   */
  dbSubnetGroupName?: string;
  /**
   * Optional DB parameter group.
   */
  dbParameterGroupName?: string;
  /**
   * VPC security groups attached to the instance.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Whether the instance is publicly reachable.
   */
  publiclyAccessible?: boolean;
  /**
   * Promotion tier inside the cluster.
   */
  promotionTier?: number;
  /**
   * Auto minor version upgrades.
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Copy tags to snapshots.
   */
  copyTagsToSnapshot?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBInstance extends Resource<
  "AWS.RDS.DBInstance",
  DBInstanceProps,
  {
    dbInstanceIdentifier: string;
    dbInstanceArn: string;
    dbClusterIdentifier: string | undefined;
    endpointAddress: string | undefined;
    endpointPort: number | undefined;
    dbInstanceClass: string | undefined;
    engine: string | undefined;
    engineVersion: string | undefined;
    status: string | undefined;
    promotionTier: number | undefined;
    publiclyAccessible: boolean | undefined;
    dbSubnetGroupName: string | undefined;
    dbParameterGroupNames: string[];
    tags: Record<string, string>;
  }
> {}

/**
 * An Aurora cluster instance.
 */
export const DBInstance = Resource<DBInstance>("AWS.RDS.DBInstance");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  instance,
  tags,
}: {
  instance: rds.DBInstance;
  tags: Record<string, string>;
}): DBInstance["Attributes"] => ({
  dbInstanceIdentifier: instance.DBInstanceIdentifier ?? "",
  dbInstanceArn: instance.DBInstanceArn ?? "",
  dbClusterIdentifier: instance.DBClusterIdentifier,
  endpointAddress: instance.Endpoint?.Address,
  endpointPort: instance.Endpoint?.Port,
  dbInstanceClass: instance.DBInstanceClass,
  engine: instance.Engine,
  engineVersion: instance.EngineVersion,
  status: instance.DBInstanceStatus,
  promotionTier: instance.PromotionTier,
  publiclyAccessible: instance.PubliclyAccessible,
  dbSubnetGroupName: instance.DBSubnetGroup?.DBSubnetGroupName,
  dbParameterGroupNames: (instance.DBParameterGroups ?? []).flatMap((group) =>
    group.DBParameterGroupName ? [group.DBParameterGroupName] : [],
  ),
  tags,
});

export const DBInstanceProvider = () =>
  Provider.effect(
    DBInstance,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBInstanceProps) =>
        props.dbInstanceIdentifier
          ? Effect.succeed(props.dbInstanceIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readInstance = Effect.fn(function* (instanceId: string) {
        const response = yield* rds
          .describeDBInstances({
            DBInstanceIdentifier: instanceId,
          })
          .pipe(
            Effect.catchTag("DBInstanceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBInstances?.[0];
      });

      const waitForInstance = Effect.fn(function* (instanceId: string) {
        const readinessPolicy = Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(30)),
        );
        return yield* readInstance(instanceId).pipe(
          Effect.flatMap((instance) =>
            instance?.DBInstanceArn
              ? Effect.succeed(instance)
              : Effect.fail(new Error(`DB instance '${instanceId}' not ready`)),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbInstanceArn", "dbInstanceIdentifier"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBInstanceProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbInstanceIdentifier ??
            (yield* toIdentifier(
              id,
              olds ?? { dbInstanceClass: "", engine: "" },
            ));
          const instance = yield* readInstance(identifier);
          if (!instance?.DBInstanceArn) {
            return undefined;
          }
          return toAttrs({ instance, tags: toTagRecord(instance.TagList) });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const identifier = yield* toIdentifier(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          yield* rds
            .createDBInstance({
              DBInstanceIdentifier: identifier,
              DBClusterIdentifier: news.dbClusterIdentifier,
              DBInstanceClass: news.dbInstanceClass,
              Engine: news.engine,
              EngineVersion: news.engineVersion,
              DBSubnetGroupName: news.dbSubnetGroupName,
              DBParameterGroupName: news.dbParameterGroupName,
              VpcSecurityGroupIds: news.vpcSecurityGroupIds,
              PubliclyAccessible: news.publiclyAccessible,
              PromotionTier: news.promotionTier,
              AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
              CopyTagsToSnapshot: news.copyTagsToSnapshot,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            })
            .pipe(
              Effect.catchTag(
                "DBInstanceAlreadyExistsFault",
                () => Effect.void,
              ),
            );

          const instance = yield* waitForInstance(identifier);
          yield* session.note(instance.DBInstanceArn ?? identifier);
          return toAttrs({ instance, tags });
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* rds.modifyDBInstance({
            DBInstanceIdentifier: output.dbInstanceIdentifier,
            DBInstanceClass: news.dbInstanceClass,
            EngineVersion: news.engineVersion,
            DBParameterGroupName: news.dbParameterGroupName,
            VpcSecurityGroupIds: news.vpcSecurityGroupIds,
            PubliclyAccessible: news.publiclyAccessible,
            PromotionTier: news.promotionTier,
            AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
            CopyTagsToSnapshot: news.copyTagsToSnapshot,
            ApplyImmediately: true,
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
          if (upsert.length > 0) {
            yield* rds.addTagsToResource({
              ResourceName: output.dbInstanceArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* rds.removeTagsFromResource({
              ResourceName: output.dbInstanceArn,
              TagKeys: removed,
            });
          }

          const instance = yield* waitForInstance(output.dbInstanceIdentifier);
          yield* session.note(output.dbInstanceArn);
          return toAttrs({ instance, tags: newTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBInstance({
              DBInstanceIdentifier: output.dbInstanceIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(
              Effect.catchTag("DBInstanceNotFoundFault", () => Effect.void),
            );
        }),
      };
    }),
  );
