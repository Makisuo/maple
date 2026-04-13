import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export interface DBProxyTargetGroupProps {
  /**
   * Proxy that owns the target group.
   */
  dbProxyName: string;
  /**
   * Target group name.
   * @default "default"
   */
  targetGroupName?: string;
  /**
   * Cluster targets registered with the proxy.
   */
  dbClusterIdentifiers?: string[];
  /**
   * Instance targets registered with the proxy.
   */
  dbInstanceIdentifiers?: string[];
  /**
   * Connection pool configuration.
   */
  connectionPoolConfig?: rds.ConnectionPoolConfiguration;
}

export interface DBProxyTargetGroup extends Resource<
  "AWS.RDS.DBProxyTargetGroup",
  DBProxyTargetGroupProps,
  {
    dbProxyName: string;
    targetGroupName: string;
    targetGroupArn: string | undefined;
    status: string | undefined;
    isDefault: boolean | undefined;
    connectionPoolConfig: rds.ConnectionPoolConfigurationInfo | undefined;
    dbClusterIdentifiers: string[];
    dbInstanceIdentifiers: string[];
  }
> {}

/**
 * The proxy target group that registers Aurora clusters or instances behind an
 * RDS Proxy.
 */
export const DBProxyTargetGroup = Resource<DBProxyTargetGroup>(
  "AWS.RDS.DBProxyTargetGroup",
);

const toTargetGroupName = (props: DBProxyTargetGroupProps) =>
  props.targetGroupName ?? "default";

export const DBProxyTargetGroupProvider = () =>
  Provider.effect(
    DBProxyTargetGroup,
    Effect.gen(function* () {
      const readGroup = Effect.fn(function* ({
        dbProxyName,
        targetGroupName,
      }: {
        dbProxyName: string;
        targetGroupName: string;
      }) {
        const response = yield* rds
          .describeDBProxyTargetGroups({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
          })
          .pipe(
            Effect.catchTag("DBProxyTargetGroupNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.TargetGroups?.[0];
      });

      const toAttrs = ({
        group,
        props,
      }: {
        group: rds.DBProxyTargetGroup;
        props: DBProxyTargetGroupProps;
      }): DBProxyTargetGroup["Attributes"] => ({
        dbProxyName: group.DBProxyName ?? props.dbProxyName,
        targetGroupName: group.TargetGroupName ?? toTargetGroupName(props),
        targetGroupArn: group.TargetGroupArn,
        status: group.Status,
        isDefault: group.IsDefault,
        connectionPoolConfig: group.ConnectionPoolConfig,
        dbClusterIdentifiers: props.dbClusterIdentifiers ?? [],
        dbInstanceIdentifiers: props.dbInstanceIdentifiers ?? [],
      });

      const applyTargets = Effect.fn(function* ({
        olds,
        news,
      }: {
        olds?: DBProxyTargetGroupProps;
        news: DBProxyTargetGroupProps;
      }) {
        const oldClusters = new Set(olds?.dbClusterIdentifiers ?? []);
        const newClusters = new Set(news.dbClusterIdentifiers ?? []);
        const oldInstances = new Set(olds?.dbInstanceIdentifiers ?? []);
        const newInstances = new Set(news.dbInstanceIdentifiers ?? []);

        const addClusters = [...newClusters].filter(
          (id) => !oldClusters.has(id),
        );
        const removeClusters = [...oldClusters].filter(
          (id) => !newClusters.has(id),
        );
        const addInstances = [...newInstances].filter(
          (id) => !oldInstances.has(id),
        );
        const removeInstances = [...oldInstances].filter(
          (id) => !newInstances.has(id),
        );

        if (news.connectionPoolConfig) {
          yield* rds.modifyDBProxyTargetGroup({
            DBProxyName: news.dbProxyName,
            TargetGroupName: toTargetGroupName(news),
            ConnectionPoolConfig: news.connectionPoolConfig,
          });
        }

        if (addClusters.length > 0 || addInstances.length > 0) {
          yield* rds.registerDBProxyTargets({
            DBProxyName: news.dbProxyName,
            TargetGroupName: toTargetGroupName(news),
            DBClusterIdentifiers:
              addClusters.length > 0 ? addClusters : undefined,
            DBInstanceIdentifiers:
              addInstances.length > 0 ? addInstances : undefined,
          });
        }

        if (removeClusters.length > 0 || removeInstances.length > 0) {
          yield* rds.deregisterDBProxyTargets({
            DBProxyName: news.dbProxyName,
            TargetGroupName: toTargetGroupName(news),
            DBClusterIdentifiers:
              removeClusters.length > 0 ? removeClusters : undefined,
            DBInstanceIdentifiers:
              removeInstances.length > 0 ? removeInstances : undefined,
          });
        }
      });

      return {
        stables: ["dbProxyName", "targetGroupArn", "targetGroupName"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.dbProxyName !== news.dbProxyName) {
            return { action: "replace" } as const;
          }
          if (toTargetGroupName(olds ?? news) !== toTargetGroupName(news)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const props = {
            dbProxyName: output?.dbProxyName ?? olds?.dbProxyName ?? "",
            targetGroupName: output?.targetGroupName ?? olds?.targetGroupName,
            dbClusterIdentifiers:
              output?.dbClusterIdentifiers ?? olds?.dbClusterIdentifiers,
            dbInstanceIdentifiers:
              output?.dbInstanceIdentifiers ?? olds?.dbInstanceIdentifiers,
            connectionPoolConfig:
              output?.connectionPoolConfig ?? olds?.connectionPoolConfig,
          } satisfies DBProxyTargetGroupProps;
          const group = yield* readGroup({
            dbProxyName: props.dbProxyName,
            targetGroupName: toTargetGroupName(props),
          });
          if (!group?.TargetGroupName) {
            return undefined;
          }
          return toAttrs({ group, props });
        }),
        create: Effect.fn(function* ({ news, session }) {
          yield* applyTargets({ news });
          const group = yield* readGroup({
            dbProxyName: news.dbProxyName,
            targetGroupName: toTargetGroupName(news),
          });
          if (!group?.TargetGroupName) {
            return yield* Effect.fail(
              new Error(
                `DB proxy target group '${toTargetGroupName(news)}' not found`,
              ),
            );
          }
          yield* session.note(group.TargetGroupArn ?? group.TargetGroupName);
          return toAttrs({ group, props: news });
        }),
        update: Effect.fn(function* ({ olds, news, output, session }) {
          yield* applyTargets({ olds, news });
          const group = yield* readGroup({
            dbProxyName: output.dbProxyName,
            targetGroupName: output.targetGroupName,
          });
          if (!group?.TargetGroupName) {
            return yield* Effect.fail(
              new Error(
                `DB proxy target group '${output.targetGroupName}' not found`,
              ),
            );
          }
          yield* session.note(output.targetGroupArn ?? output.targetGroupName);
          return toAttrs({ group, props: news });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (
            output.dbClusterIdentifiers.length > 0 ||
            output.dbInstanceIdentifiers.length > 0
          ) {
            yield* rds
              .deregisterDBProxyTargets({
                DBProxyName: output.dbProxyName,
                TargetGroupName: output.targetGroupName,
                DBClusterIdentifiers:
                  output.dbClusterIdentifiers.length > 0
                    ? output.dbClusterIdentifiers
                    : undefined,
                DBInstanceIdentifiers:
                  output.dbInstanceIdentifiers.length > 0
                    ? output.dbInstanceIdentifiers
                    : undefined,
              })
              .pipe(
                Effect.catchTag(
                  "DBProxyTargetGroupNotFoundFault",
                  () => Effect.void,
                ),
              );
          }
        }),
      };
    }),
  );
