import * as eks from "@distilled.cloud/aws/eks";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";

export interface AccessPolicyAssociation {
  /**
   * ARN of the AWS-managed EKS access policy.
   */
  policyArn: string;
  /**
   * Scope the policy applies to.
   */
  accessScope: eks.AccessScope;
}

export interface AccessEntryProps {
  /**
   * Target cluster name.
   */
  clusterName: Input<string>;
  /**
   * IAM principal ARN to grant access to.
   */
  principalArn: Input<string>;
  /**
   * Optional Kubernetes groups for the principal.
   */
  kubernetesGroups?: string[];
  /**
   * Optional username to map inside Kubernetes.
   */
  username?: string;
  /**
   * Entry type, such as `STANDARD`.
   */
  type?: string;
  /**
   * Exact set of EKS access policies associated with this entry.
   */
  accessPolicies?: AccessPolicyAssociation[];
  /**
   * User-defined tags to apply to the access entry.
   */
  tags?: Record<string, string>;
}

export interface AccessEntry extends Resource<
  "AWS.EKS.AccessEntry",
  AccessEntryProps,
  {
    accessEntryArn: string;
    clusterName: string;
    principalArn: string;
    kubernetesGroups: string[];
    username: string | undefined;
    type: string | undefined;
    accessPolicies: AccessPolicyAssociation[];
    tags: Record<string, string>;
  }
> {}

/**
 * An Amazon EKS access entry that grants an IAM principal access to a cluster.
 *
 * `AccessEntry` owns both the entry itself and the exact set of associated EKS
 * access policies, making cluster access explicit and updatable after initial
 * cluster bootstrap.
 *
 * @section Managing Cluster Access
 * @example Grant Read Access to a Role
 * ```typescript
 * const viewer = yield* AccessEntry("ViewerAccess", {
 *   clusterName: cluster.clusterName,
 *   principalArn: viewerRole.roleArn,
 *   accessPolicies: [
 *     {
 *       policyArn:
 *         "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy",
 *       accessScope: {
 *         type: "cluster",
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export const AccessEntry = Resource<AccessEntry>("AWS.EKS.AccessEntry");

export const AccessEntryProvider = () =>
  Provider.succeed(AccessEntry, {
    stables: ["accessEntryArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.clusterName !== news.clusterName) {
        return { action: "replace" } as const;
      }

      if (olds.principalArn !== news.principalArn) {
        return { action: "replace" } as const;
      }

      if ((olds.type ?? "STANDARD") !== (news.type ?? "STANDARD")) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      return yield* readAccessEntry({
        clusterName: (output?.clusterName ?? olds.clusterName) as string,
        principalArn: (output?.principalArn ?? olds.principalArn) as string,
      });
    }),
    create: Effect.fn(function* ({ id, news, session }) {
      const tags = {
        ...(yield* createInternalTags(id)),
        ...news.tags,
      };

      yield* eks
        .createAccessEntry({
          clusterName: news.clusterName as string,
          principalArn: news.principalArn as string,
          kubernetesGroups: news.kubernetesGroups,
          username: news.username,
          type: news.type,
          tags,
        })
        .pipe(
          Effect.catchTag("ResourceInUseException", () =>
            readAccessEntry({
              clusterName: news.clusterName as string,
              principalArn: news.principalArn as string,
            }).pipe(
              Effect.flatMap((existing) =>
                existing && hasAlchemyTags(id, existing.tags)
                  ? Effect.succeed(existing)
                  : Effect.fail(
                      new Error(
                        `AccessEntry '${news.principalArn as string}' already exists and is not managed by alchemy`,
                      ),
                    ),
              ),
            ),
          ),
        );

      for (const policy of normalizeAccessPolicies(news.accessPolicies)) {
        yield* eks.associateAccessPolicy({
          clusterName: news.clusterName as string,
          principalArn: news.principalArn as string,
          policyArn: policy.policyArn,
          accessScope: policy.accessScope,
        });
      }

      yield* session.note(
        `${news.clusterName as string}:${news.principalArn as string}`,
      );

      return yield* readAccessEntry({
        clusterName: news.clusterName as string,
        principalArn: news.principalArn as string,
      }).pipe(
        Effect.flatMap((state) =>
          state
            ? Effect.succeed(state)
            : Effect.fail(
                new Error(
                  `AccessEntry '${news.principalArn as string}' could not be read after creation`,
                ),
              ),
        ),
      );
    }),
    update: Effect.fn(function* ({ id, olds, news, output, session }) {
      const oldGroups = olds.kubernetesGroups ?? [];
      const newGroups = news.kubernetesGroups ?? [];

      if (
        JSON.stringify(oldGroups) !== JSON.stringify(newGroups) ||
        olds.username !== news.username
      ) {
        yield* eks.updateAccessEntry({
          clusterName: output.clusterName,
          principalArn: output.principalArn,
          kubernetesGroups: newGroups,
          username: news.username,
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
          resourceArn: output.accessEntryArn,
          tags: Object.fromEntries(
            upsert.map((tag) => [tag.Key, tag.Value] as const),
          ),
        });
      }

      if (removed.length > 0) {
        yield* eks.untagResource({
          resourceArn: output.accessEntryArn,
          tagKeys: removed,
        });
      }

      const oldPolicies = normalizeAccessPolicies(olds.accessPolicies);
      const newPolicies = normalizeAccessPolicies(news.accessPolicies);
      const oldPolicyMap = new Map(
        oldPolicies.map((policy) => [policyKey(policy), policy]),
      );
      const newPolicyMap = new Map(
        newPolicies.map((policy) => [policyKey(policy), policy]),
      );

      for (const [key, policy] of newPolicyMap) {
        if (!oldPolicyMap.has(key)) {
          yield* eks.associateAccessPolicy({
            clusterName: output.clusterName,
            principalArn: output.principalArn,
            policyArn: policy.policyArn,
            accessScope: policy.accessScope,
          });
        }
      }

      for (const [key, policy] of oldPolicyMap) {
        if (!newPolicyMap.has(key)) {
          yield* eks.disassociateAccessPolicy({
            clusterName: output.clusterName,
            principalArn: output.principalArn,
            policyArn: policy.policyArn,
          });
        }
      }

      yield* session.note(output.accessEntryArn);

      return yield* readAccessEntry({
        clusterName: output.clusterName,
        principalArn: output.principalArn,
      }).pipe(
        Effect.flatMap((state) =>
          state
            ? Effect.succeed(state)
            : Effect.fail(
                new Error(
                  `AccessEntry '${output.principalArn}' could not be read after update`,
                ),
              ),
        ),
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* eks
        .deleteAccessEntry({
          clusterName: output.clusterName,
          principalArn: output.principalArn,
        })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }),
  });

const normalizeTags = (tags: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const comparePolicyAssociation = (
  a: AccessPolicyAssociation,
  b: AccessPolicyAssociation,
) =>
  a.policyArn.localeCompare(b.policyArn) ||
  JSON.stringify(a.accessScope).localeCompare(JSON.stringify(b.accessScope));

const normalizeAccessPolicies = (
  policies:
    | ReadonlyArray<AccessPolicyAssociation | eks.AssociatedAccessPolicy>
    | undefined,
): AccessPolicyAssociation[] =>
  (policies ?? [])
    .flatMap((policy) =>
      policy.policyArn && policy.accessScope
        ? [
            {
              policyArn: policy.policyArn,
              accessScope: policy.accessScope,
            },
          ]
        : [],
    )
    .sort(comparePolicyAssociation);

const policyKey = (policy: AccessPolicyAssociation) =>
  `${policy.policyArn}::${JSON.stringify(policy.accessScope)}`;

const listAccessPolicies = Effect.fn(function* ({
  clusterName,
  principalArn,
}: {
  clusterName: string;
  principalArn: string;
}) {
  const policies: AccessPolicyAssociation[] = [];
  let nextToken: string | undefined;

  while (true) {
    const response = yield* eks.listAssociatedAccessPolicies({
      clusterName,
      principalArn,
      nextToken,
    });

    policies.push(
      ...normalizeAccessPolicies(response.associatedAccessPolicies),
    );

    if (!response.nextToken) {
      break;
    }

    nextToken = response.nextToken;
  }

  return policies.sort(comparePolicyAssociation);
});

const readAccessEntry = Effect.fn(function* ({
  clusterName,
  principalArn,
}: {
  clusterName: string;
  principalArn: string;
}) {
  const response = yield* eks
    .describeAccessEntry({
      clusterName,
      principalArn,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  const accessEntry = response?.accessEntry;
  if (
    !accessEntry?.accessEntryArn ||
    !accessEntry.clusterName ||
    !accessEntry.principalArn
  ) {
    return undefined;
  }

  return {
    accessEntryArn: accessEntry.accessEntryArn,
    clusterName: accessEntry.clusterName,
    principalArn: accessEntry.principalArn,
    kubernetesGroups: accessEntry.kubernetesGroups ?? [],
    username: accessEntry.username,
    type: accessEntry.type,
    accessPolicies: yield* listAccessPolicies({
      clusterName: accessEntry.clusterName,
      principalArn: accessEntry.principalArn,
    }),
    tags: normalizeTags(accessEntry.tags),
  };
});
