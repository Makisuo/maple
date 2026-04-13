import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  collectPages,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type RootId = string;
export type RootArn = string;

export interface RootProps {
  /**
   * Optional root ID to import explicitly.
   * If omitted, Alchemy adopts the single organization root.
   */
  rootId?: string;
  /**
   * Optional root name to match when multiple roots are ever supported.
   */
  name?: string;
  /**
   * Optional tags to apply to the imported root.
   */
  tags?: Record<string, string>;
}

export interface Root extends Resource<
  "AWS.Organizations.Root",
  RootProps,
  {
    rootId: RootId;
    rootArn: RootArn;
    rootName: string;
    policyTypes: organizations.PolicyTypeSummary[];
    tags: Record<string, string>;
  }
> {}

/**
 * The organization root.
 *
 * `Root` is an import-style resource. It discovers the existing root returned by
 * AWS Organizations and can reconcile root tags.
 */
export const Root = Resource<Root>("AWS.Organizations.Root");

export const RootProvider = () =>
  Provider.effect(
    Root,
    Effect.gen(function* () {
      return {
        stables: ["rootId", "rootArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.rootId !== news?.rootId) {
            return { action: "replace" } as const;
          }
          if (olds?.name !== news?.name) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readRoot({
            rootId: output?.rootId ?? olds?.rootId,
            name: olds?.name,
          });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const root = yield* readRoot(news);
          if (!root) {
            return yield* Effect.fail(new Error("organization root not found"));
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: root.rootId,
            olds: root.tags,
            news: news.tags,
          });

          yield* session.note(root.rootArn);
          return {
            ...root,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const root = yield* readRoot({ rootId: output.rootId });
          if (!root) {
            return yield* Effect.fail(
              new Error(`organization root '${output.rootId}' not found`),
            );
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: output.rootId,
            olds: olds.tags,
            news: news.tags,
          });

          yield* session.note(output.rootArn);
          return {
            ...root,
            tags,
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );

const listRoots = () =>
  collectPages(
    (NextToken) => organizations.listRoots({ NextToken }),
    (page) => page.Roots,
  );

const readRoot = Effect.fn(function* ({
  rootId,
  name,
}: {
  rootId?: string;
  name?: string;
}) {
  const roots = yield* retryOrganizations(listRoots());
  const root = roots.find(
    (candidate) =>
      (rootId ? candidate.Id === rootId : true) &&
      (name ? candidate.Name === name : true),
  );

  if (!root?.Id || !root.Arn || !root.Name) {
    return undefined;
  }

  const tags = yield* readResourceTags(root.Id).pipe(
    Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
  );

  return {
    rootId: root.Id,
    rootArn: root.Arn,
    rootName: root.Name,
    policyTypes: root.PolicyTypes ?? [],
    tags,
  } satisfies Root["Attributes"];
});
