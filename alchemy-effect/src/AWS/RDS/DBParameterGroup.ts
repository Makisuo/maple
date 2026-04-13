import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBParameterGroupProps {
  /**
   * Name of the parameter group. If omitted, Alchemy generates one.
   */
  dbParameterGroupName?: string;
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

export interface DBParameterGroup extends Resource<
  "AWS.RDS.DBParameterGroup",
  DBParameterGroupProps,
  {
    dbParameterGroupName: string;
    dbParameterGroupArn: string | undefined;
    family: string;
    description: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An RDS DB parameter group, useful for Aurora cluster instances.
 */
export const DBParameterGroup = Resource<DBParameterGroup>(
  "AWS.RDS.DBParameterGroup",
);

export const DBParameterGroupProvider = () =>
  Provider.effect(
    DBParameterGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: DBParameterGroupProps) =>
        props.dbParameterGroupName
          ? Effect.succeed(props.dbParameterGroupName)
          : createPhysicalName({ id, maxLength: 255 });

      const readGroup = Effect.fn(function* (name: string) {
        const response = yield* rds
          .describeDBParameterGroups({
            DBParameterGroupName: name,
          })
          .pipe(
            Effect.catchTag("DBParameterGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBParameterGroups?.[0];
      });

      return {
        stables: ["dbParameterGroupArn", "dbParameterGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? ({} as DBParameterGroupProps))) !==
            (yield* toName(id, news))
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
            output?.dbParameterGroupName ??
            (yield* toName(
              id,
              olds ?? ({ family: "" } as DBParameterGroupProps),
            ));
          const group = yield* readGroup(name);
          if (!group?.DBParameterGroupName) {
            return undefined;
          }
          return {
            dbParameterGroupName: group.DBParameterGroupName,
            dbParameterGroupArn: group.DBParameterGroupArn,
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
            .createDBParameterGroup({
              DBParameterGroupName: name,
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
                rds.describeDBParameterGroups({
                  DBParameterGroupName: name,
                }),
              ),
            );
          const group =
            "DBParameterGroup" in created
              ? created.DBParameterGroup
              : (created as rds.DBParameterGroupsMessage)
                  .DBParameterGroups?.[0];
          if (!group?.DBParameterGroupName) {
            return yield* Effect.fail(
              new Error(`Failed to create DB parameter group '${name}'`),
            );
          }
          yield* session.note(group.DBParameterGroupArn ?? name);
          return {
            dbParameterGroupName: group.DBParameterGroupName,
            dbParameterGroupArn: group.DBParameterGroupArn,
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
          if (upsert.length > 0 && output.dbParameterGroupArn) {
            yield* rds.addTagsToResource({
              ResourceName: output.dbParameterGroupArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && output.dbParameterGroupArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: output.dbParameterGroupArn,
              TagKeys: removed,
            });
          }
          yield* session.note(
            output.dbParameterGroupArn ?? output.dbParameterGroupName,
          );
          return {
            ...output,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBParameterGroup({
              DBParameterGroupName: output.dbParameterGroupName,
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
