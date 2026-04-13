import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  listGroups,
  resolveIdentityStoreId,
  retryIdentityCenter,
} from "./common.ts";

export interface GroupProps {
  /**
   * Explicit identity store ID.
   * If omitted, Alchemy resolves it from the selected Identity Center instance.
   */
  identityStoreId?: string;
  /**
   * Optional instance ARN used to discover the identity store ID.
   */
  instanceArn?: string;
  /**
   * Group display name.
   */
  displayName: string;
  /**
   * Optional group description.
   */
  description?: string;
}

export interface Group extends Resource<
  "AWS.IdentityCenter.Group",
  GroupProps,
  {
    identityStoreId: string;
    groupId: string;
    displayName: string | undefined;
    description: string | undefined;
    createdAt: Date | undefined;
    updatedAt: Date | undefined;
  }
> {}

/**
 * A group in the IAM Identity Center identity store.
 *
 * @section Creating Groups
 * @example Platform Engineers
 * ```typescript
 * const engineers = yield* Group("PlatformEngineers", {
 *   displayName: "platform-engineers",
 *   description: "Platform engineering team",
 * });
 * ```
 */
export const Group = Resource<Group>("AWS.IdentityCenter.Group");

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      return {
        stables: ["identityStoreId", "groupId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.identityStoreId !== news.identityStoreId) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.groupId && output.identityStoreId) {
            return yield* readGroupById(output.identityStoreId, output.groupId);
          }

          if (!olds) {
            return undefined;
          }

          return yield* readGroupByDisplayName(olds);
        }),
        create: Effect.fn(function* ({ news, session }) {
          const identityStoreId = yield* resolveIdentityStoreId(news);
          const existing = yield* readGroupByDisplayName({
            ...news,
            identityStoreId,
          });
          if (existing) {
            yield* session.note(existing.groupId);
            return existing;
          }

          const response = yield* retryIdentityCenter(
            identitystore.createGroup({
              IdentityStoreId: identityStoreId,
              DisplayName: news.displayName,
              Description: news.description,
            }),
          );

          const created =
            (response.GroupId
              ? yield* readGroupById(identityStoreId, response.GroupId)
              : undefined) ??
            (yield* readGroupByDisplayName({
              ...news,
              identityStoreId,
            }));

          if (!created) {
            return yield* Effect.fail(
              new Error(`group '${news.displayName}' not found after create`),
            );
          }

          yield* session.note(created.groupId);
          return created;
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          const operations = [
            {
              AttributePath: "DisplayName",
              AttributeValue: news.displayName,
            },
            {
              AttributePath: "Description",
              AttributeValue: news.description ?? "",
            },
          ];

          yield* retryIdentityCenter(
            identitystore.updateGroup({
              IdentityStoreId: output.identityStoreId,
              GroupId: output.groupId,
              Operations: operations,
            }),
          );

          const updated = yield* readGroupById(
            output.identityStoreId,
            output.groupId,
          );
          if (!updated) {
            return yield* Effect.fail(
              new Error(`group '${output.groupId}' not found after update`),
            );
          }

          yield* session.note(updated.groupId);
          return updated;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryIdentityCenter(
            identitystore
              .deleteGroup({
                IdentityStoreId: output.identityStoreId,
                GroupId: output.groupId,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

const readGroupById = Effect.fn(function* (
  identityStoreId: string,
  groupId: string,
) {
  const response = yield* retryIdentityCenter(
    identitystore
      .describeGroup({
        IdentityStoreId: identityStoreId,
        GroupId: groupId,
      })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

  if (!response?.GroupId || !response.IdentityStoreId) {
    return undefined;
  }

  return {
    identityStoreId: response.IdentityStoreId,
    groupId: response.GroupId,
    displayName: response.DisplayName as string | undefined,
    description: response.Description as string | undefined,
    createdAt: response.CreatedAt,
    updatedAt: response.UpdatedAt,
  } satisfies Group["Attributes"];
});

const readGroupByDisplayName = Effect.fn(function* ({
  identityStoreId,
  instanceArn,
  displayName,
}: Pick<GroupProps, "identityStoreId" | "instanceArn" | "displayName">) {
  const resolvedIdentityStoreId = yield* resolveIdentityStoreId({
    identityStoreId,
    instanceArn,
  });
  const groups = yield* listGroups(resolvedIdentityStoreId);
  const match = groups.find((group) => group.DisplayName === displayName);
  return match?.GroupId
    ? yield* readGroupById(resolvedIdentityStoreId, match.GroupId)
    : undefined;
});
