import * as eks from "@distilled.cloud/aws/eks";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

export interface PodIdentityAssociationProps {
  /**
   * Target cluster name.
   */
  clusterName: Input<string>;
  /**
   * Kubernetes namespace that owns the service account.
   */
  namespace: string;
  /**
   * Kubernetes service account name.
   */
  serviceAccount: string;
  /**
   * IAM role ARN assumed by pods for this association.
   */
  roleArn: Input<string>;
  /**
   * Disable session tags for the issued credentials.
   */
  disableSessionTags?: boolean;
  /**
   * Optional target role ARN for chained role assumption.
   */
  targetRoleArn?: Input<string>;
  /**
   * Optional inline session policy JSON.
   */
  policy?: string;
  /**
   * User-defined tags to apply to the association.
   */
  tags?: Record<string, string>;
}

export interface PodIdentityAssociation extends Resource<
  "AWS.EKS.PodIdentityAssociation",
  PodIdentityAssociationProps,
  {
    associationArn: string;
    associationId: string;
    clusterName: string;
    namespace: string;
    serviceAccount: string;
    roleArn: string;
    disableSessionTags: boolean;
    targetRoleArn: string | undefined;
    externalId: string | undefined;
    ownerArn: string | undefined;
    policy: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An Amazon EKS pod identity association that binds a service account to an IAM role.
 *
 * `PodIdentityAssociation` is the canonical workload-identity resource for EKS
 * clusters that use EKS Pod Identity instead of IRSA.
 *
 * @section Managing Pod Identity
 * @example Bind a Service Account to a Role
 * ```typescript
 * const association = yield* PodIdentityAssociation("ApiIdentity", {
 *   clusterName: cluster.clusterName,
 *   namespace: "default",
 *   serviceAccount: "api",
 *   roleArn: podRole.roleArn,
 * });
 * ```
 */
export const PodIdentityAssociation = Resource<PodIdentityAssociation>(
  "AWS.EKS.PodIdentityAssociation",
);

export const PodIdentityAssociationProvider = () =>
  Provider.effect(
    PodIdentityAssociation,
    Effect.gen(function* () {
      const toClientRequestToken = (id: string, action: string) =>
        createPhysicalName({
          id: `${id}-${action}`,
          maxLength: 64,
          delimiter: "-",
        });

      return {
        stables: ["associationArn", "associationId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds.clusterName !== news.clusterName) {
            return { action: "replace" } as const;
          }

          if (olds.namespace !== news.namespace) {
            return { action: "replace" } as const;
          }

          if (olds.serviceAccount !== news.serviceAccount) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.associationId) {
            return yield* readAssociationById({
              clusterName: output.clusterName,
              associationId: output.associationId,
            });
          }

          return yield* findAssociation({
            id,
            clusterName: olds.clusterName as string,
            namespace: olds.namespace,
            serviceAccount: olds.serviceAccount,
          });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          yield* eks
            .createPodIdentityAssociation({
              clusterName: news.clusterName as string,
              namespace: news.namespace,
              serviceAccount: news.serviceAccount,
              roleArn: news.roleArn as string,
              disableSessionTags: news.disableSessionTags,
              targetRoleArn: news.targetRoleArn as string | undefined,
              policy: news.policy,
              tags,
              clientRequestToken: yield* toClientRequestToken(id, "create"),
            })
            .pipe(
              Effect.catchTag("ResourceInUseException", () =>
                findAssociation({
                  id,
                  clusterName: news.clusterName as string,
                  namespace: news.namespace,
                  serviceAccount: news.serviceAccount,
                }).pipe(
                  Effect.flatMap((existing) =>
                    existing
                      ? Effect.succeed(existing)
                      : Effect.fail(
                          new Error(
                            `PodIdentityAssociation '${news.namespace}/${news.serviceAccount}' already exists and is not managed by alchemy`,
                          ),
                        ),
                  ),
                  Effect.asVoid,
                ),
              ),
            );

          const state = yield* findAssociation({
            id,
            clusterName: news.clusterName as string,
            namespace: news.namespace,
            serviceAccount: news.serviceAccount,
          });

          if (!state) {
            return yield* Effect.fail(
              new Error(
                `PodIdentityAssociation '${news.namespace}/${news.serviceAccount}' could not be read after creation`,
              ),
            );
          }

          yield* session.note(state.associationArn);
          return state;
        }),
        update: Effect.fn(function* ({ id, olds, news, output, session }) {
          if (
            olds.roleArn !== news.roleArn ||
            olds.disableSessionTags !== news.disableSessionTags ||
            olds.targetRoleArn !== news.targetRoleArn ||
            olds.policy !== news.policy
          ) {
            yield* eks.updatePodIdentityAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
              roleArn: news.roleArn as string,
              disableSessionTags: news.disableSessionTags,
              targetRoleArn: news.targetRoleArn as string | undefined,
              policy: news.policy,
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
              resourceArn: output.associationArn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value] as const),
              ),
            });
          }

          if (removed.length > 0) {
            yield* eks.untagResource({
              resourceArn: output.associationArn,
              tagKeys: removed,
            });
          }

          const state = yield* readAssociationById({
            clusterName: output.clusterName,
            associationId: output.associationId,
          });

          if (!state) {
            return yield* Effect.fail(
              new Error(
                `PodIdentityAssociation '${output.associationId}' could not be read after update`,
              ),
            );
          }

          yield* session.note(output.associationArn);
          return state;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eks
            .deletePodIdentityAssociation({
              clusterName: output.clusterName,
              associationId: output.associationId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const mapAssociation = (association: eks.PodIdentityAssociation) => ({
  associationArn: association.associationArn!,
  associationId: association.associationId!,
  clusterName: association.clusterName!,
  namespace: association.namespace!,
  serviceAccount: association.serviceAccount!,
  roleArn: association.roleArn!,
  disableSessionTags: association.disableSessionTags ?? false,
  targetRoleArn: association.targetRoleArn,
  externalId: association.externalId,
  ownerArn: association.ownerArn,
  policy: association.policy,
  tags: normalizeTags(association.tags),
});

const readAssociationById = Effect.fn(function* ({
  clusterName,
  associationId,
}: {
  clusterName: string;
  associationId: string;
}) {
  const response = yield* eks
    .describePodIdentityAssociation({
      clusterName,
      associationId,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  const association = response?.association;
  if (
    !association?.associationArn ||
    !association.associationId ||
    !association.clusterName ||
    !association.namespace ||
    !association.serviceAccount ||
    !association.roleArn
  ) {
    return undefined;
  }

  return mapAssociation(association);
});

const findAssociation = Effect.fn(function* ({
  id,
  clusterName,
  namespace,
  serviceAccount,
}: {
  id: string;
  clusterName: string;
  namespace: string;
  serviceAccount: string;
}) {
  let nextToken: string | undefined;

  while (true) {
    const response = yield* eks.listPodIdentityAssociations({
      clusterName,
      namespace,
      serviceAccount,
      nextToken,
    });

    for (const summary of response.associations ?? []) {
      if (!summary.associationId) {
        continue;
      }

      const association = yield* readAssociationById({
        clusterName,
        associationId: summary.associationId,
      });

      if (association && (yield* hasAlchemyTags(id, association.tags))) {
        return association;
      }
    }

    if (!response.nextToken) {
      return undefined;
    }

    nextToken = response.nextToken;
  }
});
