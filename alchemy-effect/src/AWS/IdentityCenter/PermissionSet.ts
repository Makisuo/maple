import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { resolveInstance, retryIdentityCenter } from "./common.ts";

export interface PermissionSetProps {
  /**
   * Explicit IAM Identity Center instance ARN.
   * If omitted, Alchemy adopts the only visible instance.
   */
  instanceArn?: string;
  /**
   * Permission set name.
   */
  name: string;
  /**
   * Optional human-readable description.
   */
  description?: string;
  /**
   * Optional ISO-8601 session duration such as `PT8H`.
   */
  sessionDuration?: string;
  /**
   * Optional relay state passed to supported applications.
   */
  relayState?: string;
}

export interface PermissionSet extends Resource<
  "AWS.IdentityCenter.PermissionSet",
  PermissionSetProps,
  {
    instanceArn: string;
    permissionSetArn: string;
    name: string;
    description: string | undefined;
    sessionDuration: string | undefined;
    relayState: string | undefined;
    createdDate: Date | undefined;
  }
> {}

/**
 * An IAM Identity Center permission set.
 *
 * @section Creating Permission Sets
 * @example Administrator Access
 * ```typescript
 * const admin = yield* PermissionSet("AdministratorAccess", {
 *   name: "AdministratorAccess",
 *   description: "Administrator access for platform engineers",
 *   sessionDuration: "PT8H",
 * });
 * ```
 */
export const PermissionSet = Resource<PermissionSet>(
  "AWS.IdentityCenter.PermissionSet",
);

export const PermissionSetProvider = () =>
  Provider.effect(
    PermissionSet,
    Effect.gen(function* () {
      return {
        stables: ["permissionSetArn", "instanceArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.instanceArn !== news.instanceArn ||
            olds?.name !== news.name
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.permissionSetArn && output.instanceArn) {
            return yield* readPermissionSetByArn({
              instanceArn: output.instanceArn,
              permissionSetArn: output.permissionSetArn,
            });
          }

          if (!olds) {
            return undefined;
          }

          return yield* readPermissionSetByName(olds);
        }),
        create: Effect.fn(function* ({ news, session }) {
          const instance = yield* resolveInstance(news.instanceArn);
          const existing = yield* readPermissionSetByName({
            ...news,
            instanceArn: instance.InstanceArn,
          });
          if (existing) {
            yield* session.note(existing.permissionSetArn);
            return existing;
          }

          const response = yield* retryIdentityCenter(
            ssoAdmin.createPermissionSet({
              InstanceArn: instance.InstanceArn!,
              Name: news.name,
              Description: news.description,
              SessionDuration: news.sessionDuration,
              RelayState: news.relayState,
            }),
          );

          const createdArn = response.PermissionSet?.PermissionSetArn;
          const created =
            (createdArn
              ? yield* readPermissionSetByArn({
                  instanceArn: instance.InstanceArn!,
                  permissionSetArn: createdArn,
                })
              : undefined) ??
            (yield* readPermissionSetByName({
              ...news,
              instanceArn: instance.InstanceArn,
            }));

          if (!created) {
            return yield* Effect.fail(
              new Error(`permission set '${news.name}' not found after create`),
            );
          }

          yield* session.note(created.permissionSetArn);
          return created;
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* retryIdentityCenter(
            ssoAdmin.updatePermissionSet({
              InstanceArn: output.instanceArn,
              PermissionSetArn: output.permissionSetArn,
              Description: news.description,
              SessionDuration: news.sessionDuration,
              RelayState: news.relayState,
            }),
          );

          const updated = yield* readPermissionSetByArn({
            instanceArn: output.instanceArn,
            permissionSetArn: output.permissionSetArn,
          });
          if (!updated) {
            return yield* Effect.fail(
              new Error(
                `permission set '${output.permissionSetArn}' not found after update`,
              ),
            );
          }

          yield* session.note(updated.permissionSetArn);
          return updated;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryIdentityCenter(
            ssoAdmin
              .deletePermissionSet({
                InstanceArn: output.instanceArn,
                PermissionSetArn: output.permissionSetArn,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

const readPermissionSetByArn = Effect.fn(function* ({
  instanceArn,
  permissionSetArn,
}: {
  instanceArn: string;
  permissionSetArn: string;
}) {
  const response = yield* retryIdentityCenter(
    ssoAdmin
      .describePermissionSet({
        InstanceArn: instanceArn,
        PermissionSetArn: permissionSetArn,
      })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

  const permissionSet = response?.PermissionSet;
  if (!permissionSet?.PermissionSetArn || !permissionSet.Name) {
    return undefined;
  }

  return {
    instanceArn,
    permissionSetArn: permissionSet.PermissionSetArn,
    name: permissionSet.Name,
    description: permissionSet.Description,
    sessionDuration: permissionSet.SessionDuration,
    relayState: permissionSet.RelayState,
    createdDate: permissionSet.CreatedDate,
  } satisfies PermissionSet["Attributes"];
});

const readPermissionSetByName = Effect.fn(function* ({
  instanceArn,
  name,
}: Pick<PermissionSetProps, "instanceArn" | "name">) {
  const instance = yield* resolveInstance(instanceArn);
  const arns = yield* ssoAdmin.listPermissionSets
    .items({
      InstanceArn: instance.InstanceArn!,
      MaxResults: 100,
    })
    .pipe(Stream.runCollect);

  for (const permissionSetArn of arns) {
    const permissionSet = yield* readPermissionSetByArn({
      instanceArn: instance.InstanceArn!,
      permissionSetArn,
    });
    if (permissionSet?.name === name) {
      return permissionSet;
    }
  }

  return undefined;
});
