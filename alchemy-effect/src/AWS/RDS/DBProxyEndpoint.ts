import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBProxyEndpointProps {
  /**
   * Proxy endpoint name. If omitted, Alchemy generates one.
   */
  dbProxyEndpointName?: string;
  /**
   * Proxy that owns the endpoint.
   */
  dbProxyName: string;
  /**
   * Subnets used by the proxy endpoint.
   */
  vpcSubnetIds: string[];
  /**
   * Security groups attached to the endpoint.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Target role for the endpoint.
   */
  targetRole?: rds.DBProxyEndpointTargetRole;
  /**
   * Endpoint network type.
   */
  endpointNetworkType?: rds.EndpointNetworkType;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBProxyEndpoint extends Resource<
  "AWS.RDS.DBProxyEndpoint",
  DBProxyEndpointProps,
  {
    dbProxyEndpointName: string;
    dbProxyEndpointArn: string;
    dbProxyName: string | undefined;
    endpoint: string | undefined;
    status: string | undefined;
    vpcId: string | undefined;
    vpcSubnetIds: string[];
    vpcSecurityGroupIds: string[];
    targetRole: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An additional RDS Proxy endpoint.
 */
export const DBProxyEndpoint = Resource<DBProxyEndpoint>(
  "AWS.RDS.DBProxyEndpoint",
);

const toAttrs = ({
  endpoint,
  tags,
}: {
  endpoint: rds.DBProxyEndpoint;
  tags: Record<string, string>;
}): DBProxyEndpoint["Attributes"] => ({
  dbProxyEndpointName: endpoint.DBProxyEndpointName ?? "",
  dbProxyEndpointArn: endpoint.DBProxyEndpointArn ?? "",
  dbProxyName: endpoint.DBProxyName,
  endpoint: endpoint.Endpoint,
  status: endpoint.Status,
  vpcId: endpoint.VpcId,
  vpcSubnetIds: endpoint.VpcSubnetIds ?? [],
  vpcSecurityGroupIds: endpoint.VpcSecurityGroupIds ?? [],
  targetRole: endpoint.TargetRole,
  tags,
});

export const DBProxyEndpointProvider = () =>
  Provider.effect(
    DBProxyEndpoint,
    Effect.gen(function* () {
      const toName = (id: string, props: DBProxyEndpointProps) =>
        props.dbProxyEndpointName
          ? Effect.succeed(props.dbProxyEndpointName)
          : createPhysicalName({ id, maxLength: 63 });

      const readEndpoint = Effect.fn(function* ({
        dbProxyName,
        dbProxyEndpointName,
      }: {
        dbProxyName: string;
        dbProxyEndpointName: string;
      }) {
        const response = yield* rds
          .describeDBProxyEndpoints({
            DBProxyName: dbProxyName,
            DBProxyEndpointName: dbProxyEndpointName,
          })
          .pipe(
            Effect.catchTag("DBProxyEndpointNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBProxyEndpoints?.[0];
      });

      const waitForEndpoint = Effect.fn(function* (props: {
        dbProxyName: string;
        dbProxyEndpointName: string;
      }) {
        const readinessPolicy = Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(30)),
        );
        return yield* readEndpoint(props).pipe(
          Effect.flatMap((endpoint) =>
            endpoint?.DBProxyEndpointArn
              ? Effect.succeed(endpoint)
              : Effect.fail(
                  new Error(
                    `DB proxy endpoint '${props.dbProxyEndpointName}' not ready`,
                  ),
                ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbProxyEndpointArn", "dbProxyEndpointName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? ({} as DBProxyEndpointProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (olds?.dbProxyName !== news.dbProxyName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const dbProxyEndpointName =
            output?.dbProxyEndpointName ??
            (yield* toName(
              id,
              olds ??
                ({
                  dbProxyName: "",
                  vpcSubnetIds: [],
                } as DBProxyEndpointProps),
            ));
          const endpoint = yield* readEndpoint({
            dbProxyName: output?.dbProxyName ?? olds?.dbProxyName ?? "",
            dbProxyEndpointName,
          });
          if (!endpoint?.DBProxyEndpointArn) {
            return undefined;
          }
          return toAttrs({ endpoint, tags: output?.tags ?? {} });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const dbProxyEndpointName = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          yield* rds
            .createDBProxyEndpoint({
              DBProxyName: news.dbProxyName,
              DBProxyEndpointName: dbProxyEndpointName,
              VpcSubnetIds: news.vpcSubnetIds,
              VpcSecurityGroupIds: news.vpcSecurityGroupIds,
              TargetRole: news.targetRole,
              EndpointNetworkType: news.endpointNetworkType,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            })
            .pipe(
              Effect.catchTag(
                "DBProxyEndpointAlreadyExistsFault",
                () => Effect.void,
              ),
            );

          const endpoint = yield* waitForEndpoint({
            dbProxyName: news.dbProxyName,
            dbProxyEndpointName,
          });
          yield* session.note(
            endpoint.DBProxyEndpointArn ?? dbProxyEndpointName,
          );
          return toAttrs({ endpoint, tags });
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* rds.modifyDBProxyEndpoint({
            DBProxyEndpointName: output.dbProxyEndpointName,
            VpcSecurityGroupIds: news.vpcSecurityGroupIds,
            NewDBProxyEndpointName:
              news.dbProxyEndpointName &&
              news.dbProxyEndpointName !== output.dbProxyEndpointName
                ? news.dbProxyEndpointName
                : undefined,
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
              ResourceName: output.dbProxyEndpointArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* rds.removeTagsFromResource({
              ResourceName: output.dbProxyEndpointArn,
              TagKeys: removed,
            });
          }

          const endpoint = yield* waitForEndpoint({
            dbProxyName: output.dbProxyName ?? news.dbProxyName,
            dbProxyEndpointName: output.dbProxyEndpointName,
          });
          yield* session.note(output.dbProxyEndpointArn);
          return toAttrs({ endpoint, tags: newTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* rds
            .deleteDBProxyEndpoint({
              DBProxyEndpointName: output.dbProxyEndpointName,
            })
            .pipe(
              Effect.catchTag(
                "DBProxyEndpointNotFoundFault",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
