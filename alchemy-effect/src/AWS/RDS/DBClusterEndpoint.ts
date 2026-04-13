import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterEndpointProps {
  /**
   * Endpoint identifier. If omitted, Alchemy generates one.
   */
  dbClusterEndpointIdentifier?: string;
  /**
   * Cluster that owns the endpoint.
   */
  dbClusterIdentifier: string;
  /**
   * Endpoint type such as `READER`, `WRITER`, or `ANY`.
   */
  endpointType: string;
  /**
   * Static members explicitly attached to the endpoint.
   */
  staticMembers?: string[];
  /**
   * Members excluded from the endpoint.
   */
  excludedMembers?: string[];
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBClusterEndpoint extends Resource<
  "AWS.RDS.DBClusterEndpoint",
  DBClusterEndpointProps,
  {
    dbClusterEndpointIdentifier: string;
    dbClusterEndpointArn: string | undefined;
    dbClusterIdentifier: string | undefined;
    endpoint: string | undefined;
    status: string | undefined;
    endpointType: string | undefined;
    customEndpointType: string | undefined;
    staticMembers: string[];
    excludedMembers: string[];
    tags: Record<string, string>;
  }
> {}

/**
 * A custom Aurora cluster endpoint.
 */
export const DBClusterEndpoint = Resource<DBClusterEndpoint>(
  "AWS.RDS.DBClusterEndpoint",
);

const toAttrs = ({
  endpoint,
  tags,
}: {
  endpoint: rds.DBClusterEndpoint;
  tags: Record<string, string>;
}): DBClusterEndpoint["Attributes"] => ({
  dbClusterEndpointIdentifier: endpoint.DBClusterEndpointIdentifier ?? "",
  dbClusterEndpointArn: endpoint.DBClusterEndpointArn,
  dbClusterIdentifier: endpoint.DBClusterIdentifier,
  endpoint: endpoint.Endpoint,
  status: endpoint.Status,
  endpointType: endpoint.EndpointType,
  customEndpointType: endpoint.CustomEndpointType,
  staticMembers: endpoint.StaticMembers ?? [],
  excludedMembers: endpoint.ExcludedMembers ?? [],
  tags,
});

export const DBClusterEndpointProvider = () =>
  Provider.effect(
    DBClusterEndpoint,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBClusterEndpointProps) =>
        props.dbClusterEndpointIdentifier
          ? Effect.succeed(props.dbClusterEndpointIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readEndpoint = Effect.fn(function* (identifier: string) {
        const response = yield* rds
          .describeDBClusterEndpoints({
            DBClusterEndpointIdentifier: identifier,
          })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusterEndpoints?.[0];
      });

      return {
        stables: ["dbClusterEndpointArn", "dbClusterEndpointIdentifier"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toIdentifier(
              id,
              olds ?? ({} as DBClusterEndpointProps),
            )) !== (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.dbClusterIdentifier !== news.dbClusterIdentifier) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterEndpointIdentifier ??
            (yield* toIdentifier(
              id,
              olds ??
                ({
                  dbClusterIdentifier: "",
                  endpointType: "READER",
                } as DBClusterEndpointProps),
            ));
          const endpoint = yield* readEndpoint(identifier);
          if (!endpoint?.DBClusterEndpointIdentifier) {
            return undefined;
          }
          return toAttrs({ endpoint, tags: output?.tags ?? {} });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const identifier = yield* toIdentifier(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          yield* rds
            .createDBClusterEndpoint({
              DBClusterIdentifier: news.dbClusterIdentifier,
              DBClusterEndpointIdentifier: identifier,
              EndpointType: news.endpointType,
              StaticMembers: news.staticMembers,
              ExcludedMembers: news.excludedMembers,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            })
            .pipe(
              Effect.catchTag(
                "DBClusterEndpointAlreadyExistsFault",
                () => Effect.void,
              ),
            );
          const endpoint = yield* readEndpoint(identifier);
          if (!endpoint?.DBClusterEndpointIdentifier) {
            return yield* Effect.fail(
              new Error(
                `DB cluster endpoint '${identifier}' not found after create`,
              ),
            );
          }
          yield* session.note(endpoint.DBClusterEndpointArn ?? identifier);
          return toAttrs({ endpoint, tags });
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* rds.modifyDBClusterEndpoint({
            DBClusterEndpointIdentifier: output.dbClusterEndpointIdentifier,
            EndpointType: news.endpointType,
            StaticMembers: news.staticMembers,
            ExcludedMembers: news.excludedMembers,
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
          if (upsert.length > 0 && output.dbClusterEndpointArn) {
            yield* rds.addTagsToResource({
              ResourceName: output.dbClusterEndpointArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && output.dbClusterEndpointArn) {
            yield* rds.removeTagsFromResource({
              ResourceName: output.dbClusterEndpointArn,
              TagKeys: removed,
            });
          }

          const endpoint = yield* readEndpoint(
            output.dbClusterEndpointIdentifier,
          );
          if (!endpoint?.DBClusterEndpointIdentifier) {
            return yield* Effect.fail(
              new Error(
                `DB cluster endpoint '${output.dbClusterEndpointIdentifier}' not found after update`,
              ),
            );
          }
          yield* session.note(
            output.dbClusterEndpointArn ?? output.dbClusterEndpointIdentifier,
          );
          return toAttrs({ endpoint, tags: newTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBClusterEndpoint({
              DBClusterEndpointIdentifier: output.dbClusterEndpointIdentifier,
            })
            .pipe(
              Effect.catchTag(
                "DBClusterEndpointNotFoundFault",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
