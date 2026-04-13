import * as eks from "@distilled.cloud/aws/eks";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

export interface AddonProps {
  /**
   * Target cluster name.
   */
  clusterName: Input<string>;
  /**
   * Add-on name, such as `metrics-server`.
   */
  addonName: string;
  /**
   * Optional add-on version. If omitted, EKS chooses the default compatible version.
   */
  addonVersion?: string;
  /**
   * IAM role ARN used by the add-on's service account.
   */
  serviceAccountRoleArn?: Input<string>;
  /**
   * Conflict resolution strategy used during create and update.
   */
  resolveConflicts?: eks.ResolveConflicts;
  /**
   * Optional add-on configuration JSON string.
   */
  configurationValues?: string;
  /**
   * Optional pod identity associations managed by the add-on.
   */
  podIdentityAssociations?: eks.AddonPodIdentityAssociations[];
  /**
   * Optional namespace override. Changing this requires replacement.
   */
  namespaceConfig?: eks.AddonNamespaceConfigRequest;
  /**
   * Preserve the add-on installation when the Alchemy resource is deleted.
   */
  preserveOnDelete?: boolean;
  /**
   * User-defined tags to apply to the add-on.
   */
  tags?: Record<string, string>;
}

export interface Addon extends Resource<
  "AWS.EKS.Addon",
  AddonProps,
  {
    addonArn: string;
    addonName: string;
    clusterName: string;
    status: eks.AddonStatus;
    addonVersion: string | undefined;
    serviceAccountRoleArn: string | undefined;
    configurationValues: string | undefined;
    podIdentityAssociations: string[];
    namespace: string | undefined;
    publisher: string | undefined;
    owner: string | undefined;
    tags: Record<string, string>;
    healthIssues: eks.AddonIssue[];
  }
> {}

/**
 * An Amazon EKS managed add-on installed on a cluster.
 *
 * `Addon` is intended for optional managed add-ons. On Auto Mode clusters, many
 * core components are already provided by AWS and do not need to be modeled as
 * explicit add-on resources.
 *
 * @section Managing Add-ons
 * @example Install Metrics Server
 * ```typescript
 * const metricsServer = yield* Addon("MetricsServer", {
 *   clusterName: cluster.clusterName,
 *   addonName: "metrics-server",
 * });
 * ```
 */
export const Addon = Resource<Addon>("AWS.EKS.Addon");

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const mapAddon = (addon: eks.Addon) => ({
  addonArn: addon.addonArn!,
  addonName: addon.addonName!,
  clusterName: addon.clusterName!,
  status: addon.status ?? "CREATING",
  addonVersion: addon.addonVersion,
  serviceAccountRoleArn: addon.serviceAccountRoleArn,
  configurationValues: addon.configurationValues,
  podIdentityAssociations: addon.podIdentityAssociations ?? [],
  namespace: addon.namespaceConfig?.namespace,
  publisher: addon.publisher,
  owner: addon.owner,
  tags: normalizeTags(addon.tags),
  healthIssues: addon.health?.issues ?? [],
});

const readAddon = Effect.fn(function* ({
  clusterName,
  addonName,
}: {
  clusterName: string;
  addonName: string;
}) {
  const response = yield* eks
    .describeAddon({
      clusterName,
      addonName,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  const addon = response?.addon;
  if (!addon?.addonArn || !addon.addonName || !addon.clusterName) {
    return undefined;
  }

  return mapAddon(addon);
});

class AddonNotReady extends Data.TaggedError("AddonNotReady")<{
  readonly clusterName: string;
  readonly addonName: string;
  readonly status: string | undefined;
}> {}

class AddonStillExists extends Data.TaggedError("AddonStillExists")<{
  readonly clusterName: string;
  readonly addonName: string;
}> {}
export const AddonProvider = () =>
  Provider.effect(
    Addon,
    Effect.gen(function* () {
      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      return {
        stables: ["addonArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds.clusterName !== news.clusterName) {
            return { action: "replace" } as const;
          }

          if (olds.addonName !== news.addonName) {
            return { action: "replace" } as const;
          }

          if (!deepEqual(olds.namespaceConfig, news.namespaceConfig)) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds }) {
          return yield* readAddon({
            clusterName: olds.clusterName as string,
            addonName: olds.addonName,
          });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          yield* eks
            .createAddon({
              clusterName: news.clusterName as string,
              addonName: news.addonName,
              addonVersion: news.addonVersion,
              serviceAccountRoleArn: news.serviceAccountRoleArn as
                | string
                | undefined,
              resolveConflicts: news.resolveConflicts,
              configurationValues: news.configurationValues,
              podIdentityAssociations: news.podIdentityAssociations,
              namespaceConfig: news.namespaceConfig,
              tags,
              clientRequestToken: yield* toClientRequestToken(id, "create"),
            })
            .pipe(
              Effect.catchTag("ResourceInUseException", () =>
                readAddon({
                  clusterName: news.clusterName as string,
                  addonName: news.addonName,
                }).pipe(
                  Effect.flatMap((existing) =>
                    existing && hasAlchemyTags(id, existing.tags)
                      ? Effect.succeed(existing)
                      : Effect.fail(
                          new Error(
                            `Addon '${news.clusterName as string}/${news.addonName}' already exists and is not managed by alchemy`,
                          ),
                        ),
                  ),
                  Effect.asVoid,
                ),
              ),
            );

          const addon = yield* waitForAddonActive({
            clusterName: news.clusterName as string,
            addonName: news.addonName,
          });
          yield* session.note(addon.addonArn);
          return addon;
        }),
        update: Effect.fn(function* ({ id, olds, news, output, session }) {
          if (
            olds.addonVersion !== news.addonVersion ||
            olds.serviceAccountRoleArn !== news.serviceAccountRoleArn ||
            olds.resolveConflicts !== news.resolveConflicts ||
            olds.configurationValues !== news.configurationValues ||
            JSON.stringify(olds.podIdentityAssociations ?? []) !==
              JSON.stringify(news.podIdentityAssociations ?? [])
          ) {
            yield* eks.updateAddon({
              clusterName: output.clusterName,
              addonName: output.addonName,
              addonVersion: news.addonVersion,
              serviceAccountRoleArn: news.serviceAccountRoleArn as
                | string
                | undefined,
              resolveConflicts: news.resolveConflicts,
              configurationValues: news.configurationValues,
              podIdentityAssociations: news.podIdentityAssociations,
              clientRequestToken: yield* toClientRequestToken(id, "update"),
            });
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
              resourceArn: output.addonArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }

          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: output.addonArn,
              tagKeys: removed,
            });
          }

          const addon = yield* waitForAddonActive({
            clusterName: output.clusterName,
            addonName: output.addonName,
          });
          yield* session.note(output.addonArn);
          return addon;
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          yield* eks
            .deleteAddon({
              clusterName: output.clusterName,
              addonName: output.addonName,
              preserve: olds.preserveOnDelete,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          if (!olds.preserveOnDelete) {
            yield* waitForAddonDeleted({
              clusterName: output.clusterName,
              addonName: output.addonName,
            });
          }
        }),
      };
    }),
  );

const waitForAddonActive = Effect.fn(function* ({
  clusterName,
  addonName,
}: {
  clusterName: string;
  addonName: string;
}) {
  return yield* readAddon({
    clusterName,
    addonName,
  }).pipe(
    Effect.flatMap((addon) => {
      if (!addon) {
        return Effect.fail(
          new AddonNotReady({
            clusterName,
            addonName,
            status: undefined,
          }),
        );
      }

      switch (addon.status) {
        case "ACTIVE":
          return Effect.succeed(addon);
        case "CREATE_FAILED":
        case "UPDATE_FAILED":
        case "DELETE_FAILED":
          return Effect.fail(
            new Error(
              `Addon '${clusterName}/${addonName}' entered terminal status '${addon.status}'`,
            ),
          );
        default:
          return Effect.fail(
            new AddonNotReady({
              clusterName,
              addonName,
              status: addon.status,
            }),
          );
      }
    }),
    Effect.retry({
      while: (error) => error instanceof AddonNotReady,
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );
});

const waitForAddonDeleted = Effect.fn(function* ({
  clusterName,
  addonName,
}: {
  clusterName: string;
  addonName: string;
}) {
  yield* readAddon({
    clusterName,
    addonName,
  }).pipe(
    Effect.flatMap((addon) =>
      addon
        ? Effect.fail(new AddonStillExists({ clusterName, addonName }))
        : Effect.void,
    ),
    Effect.retry({
      while: (error) => error instanceof AddonStillExists,
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );
});
