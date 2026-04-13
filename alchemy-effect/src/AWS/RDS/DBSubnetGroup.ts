import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { SubnetId } from "../EC2/Subnet.ts";

export interface DBSubnetGroupProps {
  /**
   * Name of the DB subnet group. If omitted, a deterministic name is generated.
   */
  dbSubnetGroupName?: string;
  /**
   * Description for the subnet group.
   * @default "Managed by Alchemy"
   */
  description?: string;
  /**
   * Subnets that the database resources may use.
   */
  subnetIds: SubnetId[];
  /**
   * User-defined tags for the subnet group.
   */
  tags?: Record<string, string>;
}

export interface DBSubnetGroup extends Resource<
  "AWS.RDS.DBSubnetGroup",
  DBSubnetGroupProps,
  {
    dbSubnetGroupName: string;
    dbSubnetGroupArn: string | undefined;
    vpcId: string | undefined;
    subnetIds: string[];
    status: string | undefined;
    supportedNetworkTypes: string[] | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An RDS DB subnet group for Aurora clusters, instances, and proxies.
 */
export const DBSubnetGroup = Resource<DBSubnetGroup>("AWS.RDS.DBSubnetGroup");

export const DBSubnetGroupProvider = () =>
  Provider.effect(
    DBSubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBSubnetGroupProps) =>
        props.dbSubnetGroupName
          ? Effect.succeed(props.dbSubnetGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (groupName: string) {
        const response = yield* rds
          .describeDBSubnetGroups({
            DBSubnetGroupName: groupName,
          })
          .pipe(
            Effect.catchTag("DBSubnetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBSubnetGroups?.[0];
      });

      return {
        stables: ["dbSubnetGroupArn", "dbSubnetGroupName", "vpcId"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbSubnetGroupName ??
            (yield* toName(
              id,
              olds ?? ({ subnetIds: [] } as DBSubnetGroupProps),
            ));
          const group = yield* readGroup(name);
          if (!group?.DBSubnetGroupName) {
            return undefined;
          }

          return {
            dbSubnetGroupName: group.DBSubnetGroupName,
            dbSubnetGroupArn: group.DBSubnetGroupArn,
            vpcId: group.VpcId,
            subnetIds: (group.Subnets ?? []).flatMap((subnet) =>
              subnet.SubnetIdentifier ? [subnet.SubnetIdentifier] : [],
            ),
            status: group.SubnetGroupStatus,
            supportedNetworkTypes: group.SupportedNetworkTypes,
            tags: output?.tags ?? {},
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const dbSubnetGroupName = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          const created = yield* rds
            .createDBSubnetGroup({
              DBSubnetGroupName: dbSubnetGroupName,
              DBSubnetGroupDescription:
                news.description ?? "Managed by Alchemy",
              SubnetIds: news.subnetIds,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            })
            .pipe(
              Effect.catchTag("DBSubnetGroupAlreadyExistsFault", () =>
                rds.describeDBSubnetGroups({
                  DBSubnetGroupName: dbSubnetGroupName,
                }),
              ),
            );

          const group =
            "DBSubnetGroup" in created
              ? created.DBSubnetGroup
              : (created as rds.DBSubnetGroupMessage).DBSubnetGroups?.[0];
          if (!group?.DBSubnetGroupName) {
            return yield* Effect.fail(
              new Error(
                `Failed to create DB subnet group '${dbSubnetGroupName}'`,
              ),
            );
          }

          yield* session.note(group.DBSubnetGroupArn ?? dbSubnetGroupName);
          return {
            dbSubnetGroupName: group.DBSubnetGroupName,
            dbSubnetGroupArn: group.DBSubnetGroupArn,
            vpcId: group.VpcId,
            subnetIds: news.subnetIds,
            status: group.SubnetGroupStatus,
            supportedNetworkTypes: group.SupportedNetworkTypes,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* rds.modifyDBSubnetGroup({
            DBSubnetGroupName: output.dbSubnetGroupName,
            DBSubnetGroupDescription: news.description ?? "Managed by Alchemy",
            SubnetIds: news.subnetIds,
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
          if (upsert.length > 0 && output.dbSubnetGroupArn) {
            yield* rds.addTagsToResource({
              ResourceName: output.dbSubnetGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && output.dbSubnetGroupArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: output.dbSubnetGroupArn,
              TagKeys: removed,
            });
          }

          const group = yield* readGroup(output.dbSubnetGroupName);
          yield* session.note(
            output.dbSubnetGroupArn ?? output.dbSubnetGroupName,
          );
          return {
            dbSubnetGroupName: output.dbSubnetGroupName,
            dbSubnetGroupArn:
              group?.DBSubnetGroupArn ?? output.dbSubnetGroupArn,
            vpcId: group?.VpcId ?? output.vpcId,
            subnetIds: news.subnetIds,
            status: group?.SubnetGroupStatus ?? output.status,
            supportedNetworkTypes:
              group?.SupportedNetworkTypes ?? output.supportedNetworkTypes,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBSubnetGroup({
              DBSubnetGroupName: output.dbSubnetGroupName,
            })
            .pipe(
              Effect.catchTag("DBSubnetGroupNotFoundFault", () => Effect.void),
            );
        }),
      };
    }),
  );
