import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export interface GroupMembershipProps {
  /**
   * Name of the IAM group to manage membership for.
   */
  groupName: Input<string>;
  /**
   * Exact set of user names that should be members of the group.
   */
  userNames: Input<string[]>;
}

export interface GroupMembership extends Resource<
  "AWS.IAM.GroupMembership",
  GroupMembershipProps,
  {
    groupName: string;
    userNames: string[];
  }
> {}

/**
 * An explicit IAM group membership resource that owns a group's managed users.
 *
 * `GroupMembership` models the exact set of users in a group, making membership
 * reconciliation explicit instead of spreading it across user or group resources.
 *
 * @section Managing Group Membership
 * @example Sync a Group's Members
 * ```typescript
 * const admins = yield* Group("Admins", {
 *   groupName: "admins",
 * });
 *
 * const alice = yield* User("Alice", {
 *   userName: "alice",
 * });
 *
 * const bob = yield* User("Bob", {
 *   userName: "bob",
 * });
 *
 * const membership = yield* GroupMembership("AdminsMembership", {
 *   groupName: admins.groupName,
 *   userNames: [alice.userName, bob.userName],
 * });
 * ```
 */
export const GroupMembership = Resource<GroupMembership>(
  "AWS.IAM.GroupMembership",
);

export const GroupMembershipProvider = () =>
  Provider.succeed(GroupMembership, {
    stables: ["groupName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.groupName !== news.groupName) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getGroup({
          GroupName: output.groupName,
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response?.Group?.GroupName) {
        return undefined;
      }
      return {
        groupName: response.Group.GroupName,
        userNames: (response.Users ?? [])
          .map((user) => user.UserName)
          .filter(
            (userName): userName is string => typeof userName === "string",
          ),
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      for (const userName of news.userNames as string[]) {
        yield* iam.addUserToGroup({
          GroupName: news.groupName as string,
          UserName: userName,
        });
      }
      yield* session.note(news.groupName as string);
      return {
        groupName: news.groupName as string,
        userNames: news.userNames as string[],
      };
    }),
    update: Effect.fn(function* ({ olds, news, output, session }) {
      const oldSet = new Set(olds.userNames as string[]);
      const newSet = new Set(news.userNames as string[]);
      for (const userName of news.userNames as string[]) {
        if (!oldSet.has(userName)) {
          yield* iam.addUserToGroup({
            GroupName: output.groupName,
            UserName: userName,
          });
        }
      }
      for (const userName of olds.userNames as string[]) {
        if (!newSet.has(userName)) {
          yield* iam
            .removeUserFromGroup({
              GroupName: output.groupName,
              UserName: userName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }
      }
      yield* session.note(output.groupName);
      return {
        groupName: output.groupName,
        userNames: news.userNames as string[],
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      for (const userName of output.userNames) {
        yield* iam
          .removeUserFromGroup({
            GroupName: output.groupName,
            UserName: userName,
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      }
    }),
  });
