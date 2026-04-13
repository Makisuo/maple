import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterParameterGroupProps {
  /**
   * Name of the parameter group. If omitted, Alchemy generates one.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Parameter group family, for example `aurora-postgresql16`.
   */
  family: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBClusterParameterGroup extends Resource<
  "AWS.RDS.DBClusterParameterGroup",
  DBClusterParameterGroupProps,
  {
    dbClusterParameterGroupName: string;
    dbClusterParameterGroupArn: string | undefined;
    family: string;
    description: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An Aurora cluster parameter group.
 */
export const DBClusterParameterGroup = Resource<DBClusterParameterGroup>(
  "AWS.RDS.DBClusterParameterGroup",
);

export const DBClusterParameterGroupProvider = () =>
  Provider.effect(
    DBClusterParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBClusterParameterGroupProps) =>
        props.dbClusterParameterGroupName
          ? Effect.succeed(props.dbClusterParameterGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* rds
          .describeDBClusterParameterGroups({
            DBClusterParameterGroupName: name,
          })
          .pipe(
            Effect.catchTag("DBParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusterParameterGroups?.[0];
      });

      return {
        stables: ["dbClusterParameterGroupArn", "dbClusterParameterGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(
              id,
              olds ?? ({} as DBClusterParameterGroupProps),
            )) !== (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds?.family !== news.family ||
            olds?.description !== news.description
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.dbClusterParameterGroupName ??
            (yield* toName(
              id,
              olds ?? ({ family: "" } as DBClusterParameterGroupProps),
            ));
          const group = yield* readGroup(name);
          if (!group?.DBClusterParameterGroupName) {
            return undefined;
          }
          return {
            dbClusterParameterGroupName: group.DBClusterParameterGroupName,
            dbClusterParameterGroupArn: group.DBClusterParameterGroupArn,
            family: group.DBParameterGroupFamily ?? olds?.family ?? "",
            description: group.Description,
            tags: output?.tags ?? {},
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const created = yield* rds
            .createDBClusterParameterGroup({
              DBClusterParameterGroupName: name,
              DBParameterGroupFamily: news.family,
              Description:
                news.description ?? `Alchemy parameter group ${name}`,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            })
            .pipe(
              Effect.catchTag("DBParameterGroupAlreadyExistsFault", () =>
                rds.describeDBClusterParameterGroups({
                  DBClusterParameterGroupName: name,
                }),
              ),
            );
          const group =
            "DBClusterParameterGroup" in created
              ? created.DBClusterParameterGroup
              : (created as rds.DBClusterParameterGroupsMessage)
                  .DBClusterParameterGroups?.[0];
          if (!group?.DBClusterParameterGroupName) {
            return yield* Effect.fail(
              new Error(
                `Failed to create DB cluster parameter group '${name}'`,
              ),
            );
          }
          yield* session.note(group.DBClusterParameterGroupArn ?? name);
          return {
            dbClusterParameterGroupName: group.DBClusterParameterGroupName,
            dbClusterParameterGroupArn: group.DBClusterParameterGroupArn,
            family: group.DBParameterGroupFamily ?? news.family,
            description: group.Description,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...olds.tags,
          };
          const newTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const { removed, upsert } = diffTags(oldTags, newTags);
          if (upsert.length > 0 && output.dbClusterParameterGroupArn) {
            yield* rds.addTagsToResource({
              ResourceName: output.dbClusterParameterGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && output.dbClusterParameterGroupArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: output.dbClusterParameterGroupArn,
              TagKeys: removed,
            });
          }
          yield* session.note(
            output.dbClusterParameterGroupArn ??
              output.dbClusterParameterGroupName,
          );
          return {
            ...output,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBClusterParameterGroup({
              DBClusterParameterGroupName: output.dbClusterParameterGroupName,
            })
            .pipe(
              Effect.catchTag(
                "DBParameterGroupNotFoundFault",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
