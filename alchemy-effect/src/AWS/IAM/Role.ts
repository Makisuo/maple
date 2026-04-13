import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import type { AccountID } from "../Account.ts";
import { Account } from "../Account.ts";
import type { PolicyDocument } from "./Policy.ts";
import {
  parsePolicyDocument,
  stringifyPolicyDocument,
  toTagRecord,
} from "./common.ts";

export type RoleName = string;
export type RoleArn = `arn:aws:iam::${AccountID}:role/${RoleName}`;

export interface RoleProps {
  /**
   * Name of the role. If omitted, a unique name will be generated.
   */
  roleName?: string;
  /**
   * Optional IAM path prefix for the role.
   * @default "/"
   */
  path?: string;
  /**
   * IAM trust policy for the role.
   */
  assumeRolePolicyDocument: PolicyDocument;
  /**
   * Managed policy ARNs to attach to the role.
   */
  managedPolicyArns?: string[];
  /**
   * Inline policies keyed by policy name.
   */
  inlinePolicies?: Record<string, PolicyDocument>;
  /**
   * Optional description for the role.
   */
  description?: string;
  /**
   * Maximum session duration in seconds.
   */
  maxSessionDuration?: number;
  /**
   * Optional managed policy ARN used as the permissions boundary.
   */
  permissionsBoundary?: string;
  /**
   * User-defined tags to apply to the role.
   */
  tags?: Record<string, string>;
}

export interface Role extends Resource<
  "AWS.IAM.Role",
  RoleProps,
  {
    roleArn: RoleArn;
    roleName: RoleName;
    roleId: string | undefined;
    path: string | undefined;
    assumeRolePolicyDocument: PolicyDocument;
    managedPolicyArns: string[];
    inlinePolicies: Record<string, PolicyDocument>;
    description: string | undefined;
    maxSessionDuration: number | undefined;
    permissionsBoundary: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An IAM role for AWS services and runtimes.
 *
 * @section Creating Roles
 * @example ECS Task Role
 * ```typescript
 * const role = yield* Role("TaskRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "ecs-tasks.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 * ```
 */
export const Role = Resource<Role>("AWS.IAM.Role");

export const RoleProvider = () =>
  Provider.effect(
    Role,
    Effect.gen(function* () {
      yield* Account;

      const toRoleName = (id: string, props: { roleName?: string } = {}) =>
        props.roleName
          ? Effect.succeed(props.roleName)
          : createPhysicalName({ id, maxLength: 64 });

      const readInlinePolicies = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listRolePolicies({
          RoleName: roleName,
        });
        const entries = yield* Effect.all(
          (listed.PolicyNames ?? []).map((policyName) =>
            iam
              .getRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.map(
                  (response) =>
                    [
                      policyName,
                      parsePolicyDocument(response.PolicyDocument),
                    ] as const,
                ),
                Effect.catchTag("NoSuchEntityException", () =>
                  Effect.succeed([policyName, undefined] as const),
                ),
              ),
          ),
        );
        return Object.fromEntries(
          entries.filter(
            (entry): entry is [string, PolicyDocument] =>
              entry[1] !== undefined,
          ),
        );
      });

      const readManagedPolicies = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listAttachedRolePolicies({
          RoleName: roleName,
        });
        return (listed.AttachedPolicies ?? [])
          .map((policy) => policy.PolicyArn)
          .filter(
            (policyArn): policyArn is string => typeof policyArn === "string",
          );
      });

      const readTags = Effect.fn(function* (roleName: string) {
        const listed = yield* iam.listRoleTags({
          RoleName: roleName,
        });
        return toTagRecord(listed.Tags);
      });

      const syncManagedPolicies = Effect.fn(function* ({
        roleName,
        olds,
        news,
      }: {
        roleName: string;
        olds: string[];
        news: string[];
      }) {
        const oldSet = new Set(olds);
        const newSet = new Set(news);

        for (const policyArn of news) {
          if (!oldSet.has(policyArn)) {
            yield* iam.attachRolePolicy({
              RoleName: roleName,
              PolicyArn: policyArn,
            });
          }
        }

        for (const policyArn of olds) {
          if (!newSet.has(policyArn)) {
            yield* iam
              .detachRolePolicy({
                RoleName: roleName,
                PolicyArn: policyArn,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      const syncInlinePolicies = Effect.fn(function* ({
        roleName,
        olds,
        news,
      }: {
        roleName: string;
        olds: Record<string, PolicyDocument>;
        news: Record<string, PolicyDocument>;
      }) {
        for (const [policyName, document] of Object.entries(news)) {
          if (
            JSON.stringify(olds[policyName] ?? null) !==
            JSON.stringify(document)
          ) {
            yield* iam.putRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
              PolicyDocument: stringifyPolicyDocument(document),
            });
          }
        }

        for (const policyName of Object.keys(olds)) {
          if (!(policyName in news)) {
            yield* iam
              .deleteRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }
      });

      return {
        stables: ["roleArn", "roleName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toRoleName(id, olds ?? {})) !==
            (yield* toRoleName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const role = yield* iam
            .getRole({
              RoleName: output.roleName,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!role?.Role) {
            return undefined;
          }

          const [managedPolicyArns, inlinePolicies, tags] = yield* Effect.all([
            readManagedPolicies(output.roleName),
            readInlinePolicies(output.roleName),
            readTags(output.roleName),
          ]);

          const assumeRolePolicyDocument =
            parsePolicyDocument(role.Role.AssumeRolePolicyDocument) ??
            output.assumeRolePolicyDocument;

          return {
            roleArn: role.Role.Arn as RoleArn,
            roleName: role.Role.RoleName,
            roleId: role.Role.RoleId,
            path: role.Role.Path,
            assumeRolePolicyDocument,
            managedPolicyArns,
            inlinePolicies,
            description: role.Role.Description,
            maxSessionDuration: role.Role.MaxSessionDuration,
            permissionsBoundary:
              role.Role.PermissionsBoundary?.PermissionsBoundaryArn,
            tags,
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const roleName = yield* toRoleName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          const created = yield* iam
            .createRole({
              Path: news.path,
              RoleName: roleName,
              AssumeRolePolicyDocument: stringifyPolicyDocument(
                news.assumeRolePolicyDocument,
              ),
              Description: news.description,
              MaxSessionDuration: news.maxSessionDuration,
              PermissionsBoundary: news.permissionsBoundary,
              Tags: createTagsList(tags),
            })
            .pipe(
              Effect.catchTag("EntityAlreadyExistsException", () =>
                iam.getRole({ RoleName: roleName }).pipe(
                  Effect.filterOrFail(
                    (existing) => hasTags(tags, existing.Role?.Tags),
                    () =>
                      new Error(
                        `Role '${roleName}' already exists and is not managed by alchemy`,
                      ),
                  ),
                ),
              ),
            );

          yield* syncManagedPolicies({
            roleName,
            olds: [],
            news: news.managedPolicyArns ?? [],
          });
          yield* syncInlinePolicies({
            roleName,
            olds: {},
            news: news.inlinePolicies ?? {},
          });

          const roleArn = (created.Role?.Arn ??
            `arn:aws:iam::${yield* Account}:role/${roleName}`) as RoleArn;
          yield* session.note(roleArn);

          return {
            roleArn,
            roleName,
            roleId: created.Role?.RoleId,
            path: created.Role?.Path ?? news.path ?? "/",
            assumeRolePolicyDocument: news.assumeRolePolicyDocument,
            managedPolicyArns: news.managedPolicyArns ?? [],
            inlinePolicies: news.inlinePolicies ?? {},
            description: news.description,
            maxSessionDuration: news.maxSessionDuration,
            permissionsBoundary: news.permissionsBoundary,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* iam.updateAssumeRolePolicy({
            RoleName: output.roleName,
            PolicyDocument: stringifyPolicyDocument(
              news.assumeRolePolicyDocument,
            ),
          });

          if (
            news.description !== olds.description ||
            news.maxSessionDuration !== olds.maxSessionDuration
          ) {
            yield* iam.updateRole({
              RoleName: output.roleName,
              Description: news.description,
              MaxSessionDuration: news.maxSessionDuration,
            });
          }

          if (news.permissionsBoundary !== olds.permissionsBoundary) {
            if (news.permissionsBoundary) {
              yield* iam.putRolePermissionsBoundary({
                RoleName: output.roleName,
                PermissionsBoundary: news.permissionsBoundary,
              });
            } else if (olds.permissionsBoundary) {
              yield* iam
                .deleteRolePermissionsBoundary({
                  RoleName: output.roleName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }

          yield* syncManagedPolicies({
            roleName: output.roleName,
            olds: olds.managedPolicyArns ?? [],
            news: news.managedPolicyArns ?? [],
          });
          yield* syncInlinePolicies({
            roleName: output.roleName,
            olds: olds.inlinePolicies ?? {},
            news: news.inlinePolicies ?? {},
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
            yield* iam.tagRole({
              RoleName: output.roleName,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagRole({
              RoleName: output.roleName,
              TagKeys: removed,
            });
          }

          const liveRole = yield* iam.getRole({
            RoleName: output.roleName,
          });

          yield* session.note(output.roleArn);
          return {
            roleArn: (liveRole.Role?.Arn ?? output.roleArn) as RoleArn,
            roleName: liveRole.Role?.RoleName ?? output.roleName,
            roleId: liveRole.Role?.RoleId ?? output.roleId,
            path: liveRole.Role?.Path ?? output.path,
            assumeRolePolicyDocument: news.assumeRolePolicyDocument,
            managedPolicyArns: news.managedPolicyArns ?? [],
            inlinePolicies: news.inlinePolicies ?? {},
            description: liveRole.Role?.Description ?? news.description,
            maxSessionDuration:
              liveRole.Role?.MaxSessionDuration ?? news.maxSessionDuration,
            permissionsBoundary:
              liveRole.Role?.PermissionsBoundary?.PermissionsBoundaryArn ??
              news.permissionsBoundary,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .deleteRolePermissionsBoundary({
              RoleName: output.roleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

          yield* iam.listRolePolicies({ RoleName: output.roleName }).pipe(
            Effect.flatMap((policies) =>
              Effect.all(
                (policies.PolicyNames ?? []).map((policyName) =>
                  iam
                    .deleteRolePolicy({
                      RoleName: output.roleName,
                      PolicyName: policyName,
                    })
                    .pipe(
                      Effect.catchTag(
                        "NoSuchEntityException",
                        () => Effect.void,
                      ),
                    ),
                ),
              ),
            ),
          );

          yield* iam
            .listAttachedRolePolicies({ RoleName: output.roleName })
            .pipe(
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.AttachedPolicies ?? []).map((policy) =>
                    iam
                      .detachRolePolicy({
                        RoleName: output.roleName,
                        PolicyArn: policy.PolicyArn!,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
            );

          yield* iam
            .deleteRole({
              RoleName: output.roleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
