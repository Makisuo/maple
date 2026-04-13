import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import { toTagRecord } from "./common.ts";

export interface InstanceProfileProps {
  /**
   * Name of the instance profile. If omitted, a deterministic name is generated.
   */
  instanceProfileName?: string;
  /**
   * Optional IAM path prefix.
   * @default "/"
   */
  path?: string;
  /**
   * Optional role attached to the instance profile.
   */
  roleName?: Input<string>;
  /**
   * User-defined tags to apply to the instance profile.
   */
  tags?: Record<string, string>;
}

export interface InstanceProfile extends Resource<
  "AWS.IAM.InstanceProfile",
  InstanceProfileProps,
  {
    instanceProfileArn: string;
    instanceProfileName: string;
    instanceProfileId: string | undefined;
    path: string | undefined;
    roleName: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An IAM instance profile that can present a role to EC2 instances.
 *
 * `InstanceProfile` bridges IAM roles into EC2 so compute instances can assume
 * the attached role through the instance metadata service.
 *
 * @section Attaching Roles to EC2
 * @example Create an Instance Profile
 * ```typescript
 * const role = yield* Role("InstanceRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "ec2.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 *
 * const profile = yield* InstanceProfile("WebProfile", {
 *   roleName: role.roleName,
 * });
 * ```
 */
export const InstanceProfile = Resource<InstanceProfile>(
  "AWS.IAM.InstanceProfile",
);

export const InstanceProfileProvider = () =>
  Provider.effect(
    InstanceProfile,
    Effect.gen(function* () {
      const toName = (id: string, props: InstanceProfileProps) =>
        props.instanceProfileName
          ? Effect.succeed(props.instanceProfileName)
          : createPhysicalName({ id, maxLength: 128 });

      const readInstanceProfile = Effect.fn(function* (name: string) {
        const response = yield* iam
          .getInstanceProfile({
            InstanceProfileName: name,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.InstanceProfile;
      });

      const syncRole = Effect.fn(function* ({
        profileName,
        currentRoleName,
        nextRoleName,
      }: {
        profileName: string;
        currentRoleName: string | undefined;
        nextRoleName: string | undefined;
      }) {
        if (currentRoleName && currentRoleName !== nextRoleName) {
          yield* iam
            .removeRoleFromInstanceProfile({
              InstanceProfileName: profileName,
              RoleName: currentRoleName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
        if (nextRoleName && currentRoleName !== nextRoleName) {
          yield* iam.addRoleToInstanceProfile({
            InstanceProfileName: profileName,
            RoleName: nextRoleName,
          });
        }
      });

      return {
        stables: [
          "instanceProfileArn",
          "instanceProfileName",
          "instanceProfileId",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? ({} as InstanceProfileProps))) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if ((olds?.path ?? "/") !== (news.path ?? "/")) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.instanceProfileName ??
            (yield* toName(id, olds ?? ({} as InstanceProfileProps)));
          const profile = yield* readInstanceProfile(name);
          if (!profile?.Arn || !profile.InstanceProfileName) {
            return undefined;
          }
          return {
            instanceProfileArn: profile.Arn,
            instanceProfileName: profile.InstanceProfileName,
            instanceProfileId: profile.InstanceProfileId,
            path: profile.Path,
            roleName: profile.Roles?.[0]?.RoleName,
            tags: toTagRecord(profile.Tags),
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          yield* iam
            .createInstanceProfile({
              InstanceProfileName: name,
              Path: news.path,
              Tags: createTagsList(tags),
            })
            .pipe(
              Effect.catchTag("EntityAlreadyExistsException", () =>
                Effect.gen(function* () {
                  const existing = yield* readInstanceProfile(name);
                  if (!existing?.Arn) {
                    return yield* Effect.fail(
                      new Error(
                        `Instance profile '${name}' already exists but could not be described`,
                      ),
                    );
                  }
                  if (!hasTags(tags, existing.Tags)) {
                    return yield* Effect.fail(
                      new Error(
                        `Instance profile '${name}' already exists and is not managed by alchemy`,
                      ),
                    );
                  }
                }),
              ),
            );

          yield* syncRole({
            profileName: name,
            currentRoleName: undefined,
            nextRoleName: news.roleName as string | undefined,
          });

          const profile = yield* readInstanceProfile(name);
          if (!profile?.Arn || !profile.InstanceProfileName) {
            return yield* Effect.fail(
              new Error(
                `Instance profile '${name}' was not readable after create`,
              ),
            );
          }

          yield* session.note(profile.Arn);
          return {
            instanceProfileArn: profile.Arn,
            instanceProfileName: profile.InstanceProfileName,
            instanceProfileId: profile.InstanceProfileId,
            path: profile.Path,
            roleName: profile.Roles?.[0]?.RoleName,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* syncRole({
            profileName: output.instanceProfileName,
            currentRoleName: olds.roleName as string | undefined,
            nextRoleName: news.roleName as string | undefined,
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
            yield* iam.tagInstanceProfile({
              InstanceProfileName: output.instanceProfileName,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagInstanceProfile({
              InstanceProfileName: output.instanceProfileName,
              TagKeys: removed,
            });
          }

          const profile = yield* readInstanceProfile(
            output.instanceProfileName,
          );
          yield* session.note(output.instanceProfileArn);
          return {
            instanceProfileArn: profile?.Arn ?? output.instanceProfileArn,
            instanceProfileName:
              profile?.InstanceProfileName ?? output.instanceProfileName,
            instanceProfileId:
              profile?.InstanceProfileId ?? output.instanceProfileId,
            path: profile?.Path ?? output.path,
            roleName: profile?.Roles?.[0]?.RoleName,
            tags: newTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const profile = yield* readInstanceProfile(
            output.instanceProfileName,
          );
          for (const role of profile?.Roles ?? []) {
            if (role.RoleName) {
              yield* iam
                .removeRoleFromInstanceProfile({
                  InstanceProfileName: output.instanceProfileName,
                  RoleName: role.RoleName,
                })
                .pipe(
                  Effect.catchTag("NoSuchEntityException", () => Effect.void),
                );
            }
          }
          yield* iam
            .deleteInstanceProfile({
              InstanceProfileName: output.instanceProfileName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
