import * as eks from "@distilled.cloud/aws/eks";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import {
  deleteObjects,
  reconcileObjects,
  type KubernetesClusterConnection,
} from "../../Kubernetes/client.ts";
import {
  type KubernetesObjectBinding,
  type KubernetesObjectDefinition,
  type KubernetesObjectRef,
} from "../../Kubernetes/types.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import type { RegionID } from "../Region.ts";

export type ClusterName = string;
export type ClusterArn =
  `arn:aws:eks:${RegionID}:${AccountID}:cluster/${ClusterName}`;

export interface ClusterProps {
  /**
   * Cluster name. If omitted, a unique name is generated.
   */
  clusterName?: string;
  /**
   * IAM role ARN assumed by the EKS control plane.
   */
  roleArn: string;
  /**
   * VPC configuration for the cluster control plane.
   */
  resourcesVpcConfig: eks.VpcConfigRequest;
  /**
   * Desired Kubernetes version.
   */
  version?: string;
  /**
   * Cluster access configuration.
   */
  accessConfig?: eks.CreateAccessConfigRequest;
  /**
   * Auto Mode compute configuration.
   */
  computeConfig?: eks.ComputeConfigRequest;
  /**
   * Auto Mode storage configuration.
   */
  storageConfig?: eks.StorageConfigRequest;
  /**
   * Kubernetes network configuration.
   */
  kubernetesNetworkConfig?: eks.KubernetesNetworkConfigRequest;
  /**
   * Control plane logging configuration.
   */
  logging?: eks.Logging;
  /**
   * Upgrade support policy for the cluster.
   */
  upgradePolicy?: eks.UpgradePolicyRequest;
  /**
   * Whether deletion protection is enabled.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * User-defined tags to apply to the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.EKS.Cluster",
  ClusterProps,
  {
    clusterArn: ClusterArn;
    clusterName: ClusterName;
    status: string;
    endpoint: string | undefined;
    certificateAuthorityData: string | undefined;
    version: string | undefined;
    platformVersion: string | undefined;
    roleArn: string;
    resourcesVpcConfig: eks.VpcConfigResponse;
    accessConfig: eks.AccessConfigResponse | undefined;
    computeConfig: eks.ComputeConfigResponse | undefined;
    storageConfig: eks.StorageConfigResponse | undefined;
    kubernetesNetworkConfig: eks.KubernetesNetworkConfigResponse | undefined;
    logging: eks.Logging | undefined;
    upgradePolicy: eks.UpgradePolicyResponse | undefined;
    deletionProtection: boolean;
    oidcIssuer: string | undefined;
    tags: Record<string, string>;
    kubernetesObjects: KubernetesObjectRef[];
  },
  KubernetesObjectBinding
> {}

/**
 * An Amazon EKS cluster with support for EKS Auto Mode settings.
 *
 * @section Creating Clusters
 * @example Auto Mode Cluster from Existing Roles and Subnets
 * ```typescript
 * const cluster = yield* Cluster("AppCluster", {
 *   roleArn: clusterRole.roleArn,
 *   resourcesVpcConfig: {
 *     subnetIds: network.privateSubnetIds,
 *     endpointPublicAccess: true,
 *     endpointPrivateAccess: true,
 *   },
 *   accessConfig: {
 *     authenticationMode: "API",
 *   },
 *   computeConfig: {
 *     enabled: true,
 *     nodeRoleArn: nodeRole.roleArn,
 *     nodePools: ["system", "general-purpose"],
 *   },
 *   kubernetesNetworkConfig: {
 *     elasticLoadBalancing: { enabled: true },
 *   },
 *   storageConfig: {
 *     blockStorage: { enabled: true },
 *   },
 * });
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.EKS.Cluster");

class ClusterNotReady extends Data.TaggedError("EKS.ClusterNotReady")<{
  status: string | undefined;
}> {}

class ClusterStillExists extends Data.TaggedError(
  "EKS.ClusterStillExists",
)<{}> {}

class ClusterUpdateNotComplete extends Data.TaggedError(
  "EKS.ClusterUpdateNotComplete",
)<{
  status: eks.UpdateStatus | undefined;
}> {}

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const jsonEqual = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? undefined) === JSON.stringify(b ?? undefined);

const updateRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.both(Schedule.recurs(120)),
);

const getKubernetesConnection = (
  state: Pick<
    Cluster["Attributes"],
    "clusterName" | "endpoint" | "certificateAuthorityData"
  >,
): KubernetesClusterConnection => {
  if (!state.endpoint || !state.certificateAuthorityData) {
    throw new Error(
      `EKS cluster '${state.clusterName}' is missing endpoint or certificate authority data`,
    );
  }

  return {
    clusterName: state.clusterName,
    endpoint: state.endpoint,
    certificateAuthorityData: state.certificateAuthorityData,
  };
};

const getDesiredKubernetesObjects = (
  bindings: ReadonlyArray<ResourceBinding<KubernetesObjectBinding>>,
): KubernetesObjectDefinition[] =>
  bindings
    .filter(
      (binding): binding is ResourceBinding<KubernetesObjectBinding> =>
        binding.data.type === "kubernetes-object",
    )
    .map((binding) => binding.data.object);

const clusterConfigChanged = (olds: ClusterProps, news: ClusterProps) =>
  !jsonEqual(olds.resourcesVpcConfig, news.resourcesVpcConfig) ||
  !jsonEqual(
    olds.accessConfig?.authenticationMode,
    news.accessConfig?.authenticationMode,
  ) ||
  !jsonEqual(olds.computeConfig, news.computeConfig) ||
  !jsonEqual(olds.storageConfig, news.storageConfig) ||
  !jsonEqual(olds.kubernetesNetworkConfig, news.kubernetesNetworkConfig) ||
  !jsonEqual(olds.logging, news.logging) ||
  !jsonEqual(olds.upgradePolicy, news.upgradePolicy) ||
  (olds.deletionProtection ?? false) !== (news.deletionProtection ?? false);

const mapClusterState = (
  cluster: eks.Cluster,
  tags: Record<string, string>,
  kubernetesObjects: KubernetesObjectRef[],
): Cluster["Attributes"] => ({
  clusterArn: cluster.arn as ClusterArn,
  clusterName: cluster.name!,
  status: cluster.status ?? "CREATING",
  endpoint: cluster.endpoint,
  certificateAuthorityData: cluster.certificateAuthority?.data,
  version: cluster.version,
  platformVersion: cluster.platformVersion,
  roleArn: cluster.roleArn!,
  resourcesVpcConfig: {
    subnetIds: cluster.resourcesVpcConfig?.subnetIds ?? [],
    securityGroupIds: cluster.resourcesVpcConfig?.securityGroupIds ?? [],
    clusterSecurityGroupId: cluster.resourcesVpcConfig?.clusterSecurityGroupId,
    vpcId: cluster.resourcesVpcConfig?.vpcId,
    endpointPublicAccess: cluster.resourcesVpcConfig?.endpointPublicAccess,
    endpointPrivateAccess: cluster.resourcesVpcConfig?.endpointPrivateAccess,
    publicAccessCidrs: cluster.resourcesVpcConfig?.publicAccessCidrs ?? [],
  },
  accessConfig: cluster.accessConfig,
  computeConfig: cluster.computeConfig,
  storageConfig: cluster.storageConfig,
  kubernetesNetworkConfig: cluster.kubernetesNetworkConfig,
  logging: cluster.logging,
  upgradePolicy: cluster.upgradePolicy,
  deletionProtection: cluster.deletionProtection ?? false,
  oidcIssuer: cluster.identity?.oidc?.issuer,
  tags,
  kubernetesObjects,
});

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const toClusterName = (
        id: string,
        props: { clusterName?: string } = {},
      ) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 100 });

      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      const validateProps = Effect.fn(function* (props: ClusterProps) {
        const subnetIds = props.resourcesVpcConfig.subnetIds ?? [];
        if (subnetIds.length < 2) {
          return yield* Effect.fail(
            new Error("AWS.EKS.Cluster requires at least two subnet IDs"),
          );
        }
        if (
          props.computeConfig?.enabled &&
          props.accessConfig?.authenticationMode === "CONFIG_MAP"
        ) {
          return yield* Effect.fail(
            new Error(
              "AWS.EKS.Cluster Auto Mode requires accessConfig.authenticationMode to include API access",
            ),
          );
        }
      });

      const readCluster = Effect.fn(function* ({
        clusterName,
        kubernetesObjects,
      }: {
        clusterName: string;
        kubernetesObjects?: KubernetesObjectRef[];
      }) {
        const described = yield* eks
          .describeCluster({
            name: clusterName,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const cluster = described?.cluster;
        if (!cluster?.arn || !cluster.name || !cluster.roleArn) {
          return undefined;
        }
        const listedTags = yield* eks
          .listTagsForResource({
            resourceArn: cluster.arn,
          })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const tags = normalizeTags(listedTags?.tags ?? cluster.tags);
        return mapClusterState(cluster, tags, kubernetesObjects ?? []);
      });

      const resolveOwnedCluster = Effect.fn(function* (
        id: string,
        clusterName: string,
      ) {
        const state = yield* readCluster({
          clusterName,
        });
        if (!state) {
          return yield* Effect.fail(
            new Error(`cluster '${clusterName}' exists but could not be read`),
          );
        }
        if (!(yield* hasAlchemyTags(id, state.tags))) {
          return yield* Effect.fail(
            new Error(
              `cluster '${clusterName}' already exists and is not managed by alchemy`,
            ),
          );
        }
        return state;
      });

      const waitForClusterActive = (
        clusterName: string,
        kubernetesObjects: KubernetesObjectRef[] = [],
      ) =>
        readCluster({
          clusterName,
          kubernetesObjects,
        }).pipe(
          Effect.flatMap((state) => {
            if (!state) {
              return Effect.fail(
                new ClusterNotReady({
                  status: undefined,
                }),
              );
            }
            if (state.status === "ACTIVE") {
              return Effect.succeed(state);
            }
            if (state.status === "FAILED") {
              return Effect.fail(
                new Error(`EKS cluster '${clusterName}' entered FAILED state`),
              );
            }
            return Effect.fail(
              new ClusterNotReady({
                status: state.status,
              }),
            );
          }),
          Effect.retry({
            while: (error) => error instanceof ClusterNotReady,
            schedule: updateRetrySchedule,
          }),
        );

      const waitForClusterDeleted = (clusterName: string) =>
        readCluster({
          clusterName,
        }).pipe(
          Effect.flatMap((state) =>
            state
              ? Effect.fail(new ClusterStillExists())
              : Effect.succeed(undefined),
          ),
          Effect.retry({
            while: (error) => error instanceof ClusterStillExists,
            schedule: updateRetrySchedule,
          }),
        );

      const waitForUpdate = (clusterName: string, updateId: string) =>
        eks
          .describeUpdate({
            name: clusterName,
            updateId,
          })
          .pipe(
            Effect.flatMap(({ update }) => {
              if (update?.status === "Successful") {
                return Effect.succeed(update);
              }
              if (
                update?.status === "Failed" ||
                update?.status === "Cancelled"
              ) {
                return Effect.fail(
                  new Error(
                    `EKS cluster update '${updateId}' failed with status '${update?.status}'`,
                  ),
                );
              }
              return Effect.fail(
                new ClusterUpdateNotComplete({
                  status: update?.status,
                }),
              );
            }),
            Effect.retry({
              while: (error) => error instanceof ClusterUpdateNotComplete,
              schedule: updateRetrySchedule,
            }),
          );

      return {
        stables: ["clusterArn", "clusterName"],
        diff: Effect.fn(function* ({ id, olds = {} as ClusterProps, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toClusterName(id, olds)) !==
            (yield* toClusterName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (olds.roleArn !== news.roleArn) {
            return { action: "replace" } as const;
          }
          if (
            olds.accessConfig?.bootstrapClusterCreatorAdminPermissions !==
            news.accessConfig?.bootstrapClusterCreatorAdminPermissions
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds.kubernetesNetworkConfig?.serviceIpv4Cidr !==
              news.kubernetesNetworkConfig?.serviceIpv4Cidr ||
            olds.kubernetesNetworkConfig?.ipFamily !==
              news.kubernetesNetworkConfig?.ipFamily
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds.computeConfig?.nodeRoleArn !==
              news.computeConfig?.nodeRoleArn &&
            (olds.computeConfig?.enabled || news.computeConfig?.enabled)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const clusterName =
            output?.clusterName ?? (yield* toClusterName(id, olds ?? {}));
          return yield* readCluster({
            clusterName,
            kubernetesObjects: output?.kubernetesObjects,
          });
        }),
        create: Effect.fn(function* ({ id, news, bindings, session }) {
          yield* validateProps(news);

          const clusterName = yield* toClusterName(id, news);
          const desiredObjects = getDesiredKubernetesObjects(bindings);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          yield* eks
            .createCluster({
              name: clusterName,
              version: news.version,
              roleArn: news.roleArn,
              resourcesVpcConfig: news.resourcesVpcConfig,
              kubernetesNetworkConfig: news.kubernetesNetworkConfig,
              logging: news.logging,
              accessConfig: news.accessConfig,
              computeConfig: news.computeConfig,
              storageConfig: news.storageConfig,
              deletionProtection: news.deletionProtection,
              upgradePolicy: news.upgradePolicy,
              tags,
              clientRequestToken: yield* toClientRequestToken(id, "create"),
            })
            .pipe(
              Effect.catchTag("ResourceInUseException", () =>
                resolveOwnedCluster(id, clusterName).pipe(Effect.asVoid),
              ),
            );

          yield* session.note(`Creating EKS cluster ${clusterName}...`);
          const cluster = yield* waitForClusterActive(clusterName);
          const kubernetesObjects = yield* reconcileObjects({
            connection: getKubernetesConnection(cluster),
            previousObjects: [],
            desiredObjects,
          });
          return {
            ...cluster,
            kubernetesObjects,
          };
        }),
        update: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          bindings,
          session,
        }) {
          yield* validateProps(news);

          if (clusterConfigChanged(olds, news)) {
            const configUpdate = yield* eks.updateClusterConfig({
              name: output.clusterName,
              resourcesVpcConfig: news.resourcesVpcConfig,
              logging: news.logging,
              accessConfig: news.accessConfig
                ? {
                    authenticationMode: news.accessConfig.authenticationMode,
                  }
                : undefined,
              upgradePolicy: news.upgradePolicy,
              computeConfig: news.computeConfig,
              kubernetesNetworkConfig: news.kubernetesNetworkConfig,
              storageConfig: news.storageConfig,
              deletionProtection: news.deletionProtection,
              clientRequestToken: yield* toClientRequestToken(id, "config"),
            });
            if (configUpdate.update?.id) {
              yield* session.note(
                `Updating EKS cluster config ${output.clusterName}...`,
              );
              yield* waitForUpdate(output.clusterName, configUpdate.update.id);
              yield* waitForClusterActive(
                output.clusterName,
                output.kubernetesObjects ?? [],
              );
            }
          }

          if (olds.version !== news.version && news.version) {
            const versionUpdate = yield* eks.updateClusterVersion({
              name: output.clusterName,
              version: news.version,
              clientRequestToken: yield* toClientRequestToken(id, "version"),
            });
            if (versionUpdate.update?.id) {
              yield* session.note(
                `Updating EKS cluster version ${output.clusterName}...`,
              );
              yield* waitForUpdate(output.clusterName, versionUpdate.update.id);
              yield* waitForClusterActive(
                output.clusterName,
                output.kubernetesObjects ?? [],
              );
            }
          }

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
            yield* eks.tagResource({
              resourceArn: output.clusterArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }
          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: output.clusterArn,
              tagKeys: removed,
            });
          }

          yield* session.note(output.clusterArn);

          const state = yield* readCluster({
            clusterName: output.clusterName,
            kubernetesObjects: output.kubernetesObjects ?? [],
          }).pipe(
            Effect.flatMap((state) =>
              state
                ? Effect.succeed(state)
                : Effect.fail(
                    new Error(
                      `EKS cluster '${output.clusterName}' could not be read after update`,
                    ),
                  ),
            ),
          );

          const kubernetesObjects = yield* reconcileObjects({
            connection: getKubernetesConnection(state),
            previousObjects: output.kubernetesObjects ?? [],
            desiredObjects: getDesiredKubernetesObjects(bindings),
          });

          return {
            ...state,
            kubernetesObjects,
          };
        }),
        delete: Effect.fn(function* ({ id, output }) {
          if ((output.kubernetesObjects ?? []).length > 0) {
            yield* deleteObjects({
              connection: getKubernetesConnection(output),
              objects: output.kubernetesObjects ?? [],
            });
          }

          if (output.deletionProtection) {
            const disableDeletionProtection = yield* eks.updateClusterConfig({
              name: output.clusterName,
              deletionProtection: false,
              clientRequestToken: yield* toClientRequestToken(
                id,
                "disable-deletion-protection",
              ),
            });
            if (disableDeletionProtection.update?.id) {
              yield* waitForUpdate(
                output.clusterName,
                disableDeletionProtection.update.id,
              );
              yield* waitForClusterActive(
                output.clusterName,
                output.kubernetesObjects ?? [],
              );
            }
          }

          yield* eks
            .deleteCluster({
              name: output.clusterName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* waitForClusterDeleted(output.clusterName);
        }),
      };
    }),
  );
