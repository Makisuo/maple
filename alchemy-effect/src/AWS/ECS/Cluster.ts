import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { Account, type AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type ClusterName = string;
export type ClusterArn =
  `arn:aws:ecs:${RegionID}:${AccountID}:cluster/${ClusterName}`;

export interface ClusterProps {
  /**
   * Cluster name. If omitted, a unique name is generated.
   */
  clusterName?: string;
  /**
   * ECS cluster settings such as container insights.
   */
  settings?: ecs.ClusterSetting[];
  /**
   * Cluster configuration such as execute command logging.
   */
  configuration?: ecs.ClusterConfiguration;
  /**
   * Optional capacity providers associated with the cluster.
   */
  capacityProviders?: string[];
  /**
   * Default capacity provider strategy for the cluster.
   */
  defaultCapacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];
  /**
   * Optional Service Connect defaults for the cluster.
   */
  serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
  /**
   * User-defined tags to apply to the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.ECS.Cluster",
  ClusterProps,
  {
    clusterArn: ClusterArn;
    clusterName: ClusterName;
    status: string;
    settings: ecs.ClusterSetting[];
    configuration?: ecs.ClusterConfiguration;
    capacityProviders: string[];
    defaultCapacityProviderStrategy: ecs.CapacityProviderStrategyItem[];
    serviceConnectDefaults?: ecs.ClusterServiceConnectDefaultsRequest;
    tags: Record<string, string>;
  }
> {}

/**
 * An Amazon ECS cluster for running tasks and services.
 *
 * @section Creating Clusters
 * @example Default Cluster
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {});
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.ECS.Cluster");

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const region = yield* Region;
      const accountId = yield* Account;

      const toEcsTags = (tags: Record<string, string>): ecs.Tag[] =>
        Object.entries(tags).map(([key, value]) => ({
          key,
          value,
        }));

      const toClusterName = (
        id: string,
        props: { clusterName?: string } = {},
      ) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const applyCapacityProviders = Effect.fn(function* ({
        cluster,
        capacityProviders,
        defaultCapacityProviderStrategy,
      }: {
        cluster: string;
        capacityProviders?: string[];
        defaultCapacityProviderStrategy?: ecs.CapacityProviderStrategyItem[];
      }) {
        if (
          capacityProviders !== undefined ||
          defaultCapacityProviderStrategy !== undefined
        ) {
          yield* ecs.putClusterCapacityProviders({
            cluster,
            capacityProviders: capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              defaultCapacityProviderStrategy ?? [],
          });
        }
      });

      return {
        stables: ["clusterArn", "clusterName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toClusterName(id, olds ?? {})) !==
            (yield* toClusterName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName =
            output?.clusterName ?? (yield* toClusterName(id, olds ?? {}));
          const described = yield* ecs.describeClusters({
            clusters: [output?.clusterArn ?? clusterName],
            include: ["SETTINGS", "TAGS", "CONFIGURATIONS"],
          });
          const cluster = described.clusters?.[0];
          if (!cluster?.clusterArn) {
            return undefined;
          }
          return {
            clusterArn: cluster.clusterArn as ClusterArn,
            clusterName: cluster.clusterName!,
            status: cluster.status ?? "ACTIVE",
            settings: cluster.settings ?? [],
            configuration: cluster.configuration,
            capacityProviders: cluster.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              cluster.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: cluster.serviceConnectDefaults?.namespace
              ? { namespace: cluster.serviceConnectDefaults.namespace }
              : undefined,
            tags: output?.tags ?? {},
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const clusterName = yield* toClusterName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const created = yield* ecs.createCluster({
            clusterName,
            settings: news.settings,
            configuration: news.configuration,
            serviceConnectDefaults: news.serviceConnectDefaults,
            tags: toEcsTags(tags),
          });
          yield* applyCapacityProviders({
            cluster: clusterName,
            capacityProviders: news.capacityProviders,
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy,
          });

          const cluster = created.cluster;
          const clusterArn = (cluster?.clusterArn ??
            `arn:aws:ecs:${region}:${accountId}:cluster/${clusterName}`) as ClusterArn;
          yield* session.note(clusterArn);

          return {
            clusterArn,
            clusterName,
            status: cluster?.status ?? "ACTIVE",
            settings: news.settings ?? [],
            configuration: news.configuration,
            capacityProviders: news.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: news.serviceConnectDefaults,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* ecs.updateCluster({
            cluster: output.clusterArn,
            settings: news.settings,
            configuration: news.configuration,
            serviceConnectDefaults: news.serviceConnectDefaults,
          });
          yield* applyCapacityProviders({
            cluster: output.clusterArn,
            capacityProviders: news.capacityProviders,
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy,
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
            yield* ecs.tagResource({
              resourceArn: output.clusterArn,
              tags: upsert.map((tag) => ({ key: tag.Key, value: tag.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ecs.untagResource({
              resourceArn: output.clusterArn,
              tagKeys: removed,
            });
          }

          yield* session.note(output.clusterArn);
          return {
            ...output,
            settings: news.settings ?? [],
            configuration: news.configuration,
            capacityProviders: news.capacityProviders ?? [],
            defaultCapacityProviderStrategy:
              news.defaultCapacityProviderStrategy ?? [],
            serviceConnectDefaults: news.serviceConnectDefaults,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ecs
            .deleteCluster({
              cluster: output.clusterArn,
            })
            .pipe(
              Effect.catchTag("ClusterNotFoundException", () => Effect.void),
              Effect.catchTag(
                "ClusterContainsServicesException",
                () => Effect.void,
              ),
              Effect.catchTag(
                "ClusterContainsTasksException",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
