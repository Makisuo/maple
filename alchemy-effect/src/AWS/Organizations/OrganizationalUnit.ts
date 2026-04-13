import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  collectPages,
  createName,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type OrganizationalUnitId = string;
export type OrganizationalUnitArn = string;

export interface OrganizationalUnitProps {
  /**
   * Parent root or OU ID.
   */
  parentId: string;
  /**
   * OU name. If omitted, Alchemy generates one.
   */
  name?: string;
  /**
   * Optional tags applied to the OU.
   */
  tags?: Record<string, string>;
}

export interface OrganizationalUnit extends Resource<
  "AWS.Organizations.OrganizationalUnit",
  OrganizationalUnitProps,
  {
    ouId: OrganizationalUnitId;
    ouArn: OrganizationalUnitArn;
    name: string;
    parentId: string | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * An AWS Organizations organizational unit.
 *
 * @section Creating OUs
 * @example Nested OU
 * ```typescript
 * const workloads = yield* OrganizationalUnit("Workloads", {
 *   parentId: root.rootId,
 *   name: "workloads",
 * });
 * ```
 */
export const OrganizationalUnit = Resource<OrganizationalUnit>(
  "AWS.Organizations.OrganizationalUnit",
);

export const OrganizationalUnitProvider = () =>
  Provider.effect(
    OrganizationalUnit,
    Effect.gen(function* () {
      return {
        stables: ["ouId", "ouArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});

          if (olds?.parentId !== news?.parentId) {
            return { action: "replace" } as const;
          }

          if (oldName !== newName) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.ouId) {
            return yield* readOUById(output.ouId);
          }

          const parentId = olds?.parentId;
          if (!parentId) {
            return undefined;
          }

          return yield* readOUByParentAndName({
            parentId,
            name: yield* toName(id, olds ?? {}),
          });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const existing = yield* readOUByParentAndName({
            parentId: news.parentId,
            name,
          });

          if (existing) {
            yield* ensureOwnedByAlchemy(
              id,
              existing.ouId,
              existing.tags,
              "organizational unit",
            );
          } else {
            yield* retryOrganizations(
              organizations
                .createOrganizationalUnit({
                  ParentId: news.parentId,
                  Name: name,
                })
                .pipe(
                  Effect.catchTag(
                    "DuplicateOrganizationalUnitException",
                    () => Effect.void,
                  ),
                ),
            );
          }

          const created = yield* readOUByParentAndName({
            parentId: news.parentId,
            name,
          });
          if (!created) {
            return yield* Effect.fail(
              new Error(`organizational unit '${name}' not found after create`),
            );
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: created.ouId,
            olds: created.tags,
            news: news.tags,
          });

          yield* session.note(created.ouArn);
          return {
            ...created,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const newName = yield* toName(id, news);
          if (output.name !== newName) {
            yield* retryOrganizations(
              organizations.updateOrganizationalUnit({
                OrganizationalUnitId: output.ouId,
                Name: newName,
              }),
            );
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: output.ouId,
            olds: olds.tags,
            news: news.tags,
          });

          const updated = yield* readOUById(output.ouId);
          if (!updated) {
            return yield* Effect.fail(
              new Error(
                `organizational unit '${output.ouId}' not found after update`,
              ),
            );
          }

          yield* session.note(output.ouArn);
          return {
            ...updated,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .deleteOrganizationalUnit({
                OrganizationalUnitId: output.ouId,
              })
              .pipe(
                Effect.catchTag(
                  "OrganizationalUnitNotFoundException",
                  () => Effect.void,
                ),
              ),
          );
        }),
      };
    }),
  );

const toName = (id: string, props: { name?: string } = {}) =>
  createName(id, props.name, 128);

const listOUsForParent = (parentId: string) =>
  collectPages(
    (NextToken) =>
      organizations.listOrganizationalUnitsForParent({
        ParentId: parentId,
        NextToken,
      }),
    (page) => page.OrganizationalUnits,
  ).pipe(retryOrganizations);

const readParentId = (childId: string) =>
  collectPages(
    (NextToken) => organizations.listParents({ ChildId: childId, NextToken }),
    (page) => page.Parents,
  ).pipe(
    retryOrganizations,
    Effect.map((parents) => parents[0]?.Id),
  );

const readOUById = Effect.fn(function* (ouId: string) {
  const described = yield* retryOrganizations(
    organizations
      .describeOrganizationalUnit({
        OrganizationalUnitId: ouId,
      })
      .pipe(
        Effect.map((response) => response.OrganizationalUnit),
        Effect.catchTag("OrganizationalUnitNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

  if (!described?.Id || !described.Arn || !described.Name) {
    return undefined;
  }

  const [parentId, tags] = yield* Effect.all([
    readParentId(described.Id).pipe(
      Effect.catchTag("ChildNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
    readResourceTags(described.Id).pipe(
      Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
    ),
  ]);

  return {
    ouId: described.Id,
    ouArn: described.Arn,
    name: described.Name,
    parentId,
    tags,
  } satisfies OrganizationalUnit["Attributes"];
});

const readOUByParentAndName = Effect.fn(function* ({
  parentId,
  name,
}: {
  parentId: string;
  name: string;
}) {
  const match = (yield* listOUsForParent(parentId)).find(
    (ou) => ou.Name === name,
  );
  return match?.Id ? yield* readOUById(match.Id) : undefined;
});
