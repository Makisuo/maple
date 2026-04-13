import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";
import { KVNamespaceBinding } from "./KVNamespaceBinding.ts";

export type NamespaceProps = {
  /**
   * A human-readable string name for the namespace.
   * If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  title?: string;
};

export type KVNamespace = Resource<
  "Cloudflare.KVNamespace",
  NamespaceProps,
  {
    title: string;
    namespaceId: string;
    supportsUrlEncoding: boolean | undefined;
    accountId: string;
  }
>;

export const KVNamespace = Resource<KVNamespace>("Cloudflare.KVNamespace")({
  bind: KVNamespaceBinding.bind,
});

export const NamespaceProvider = () =>
  Provider.effect(
    KVNamespace,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createNamespace = yield* kv.createNamespace;
      const updateNamespace = yield* kv.updateNamespace;
      const deleteNamespace = yield* kv.deleteNamespace;
      const getNamespaceFn = yield* kv.getNamespace;
      const listNamespaces = yield* kv.listNamespaces;

      const createTitle = (id: string, title: string | undefined) =>
        Effect.gen(function* () {
          return title ?? (yield* createPhysicalName({ id }));
        });

      return {
        stables: ["namespaceId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const title = yield* createTitle(id, news.title);
          const oldTitle =
            output?.title ?? (yield* createTitle(id, olds.title));
          if (title !== oldTitle) {
            return { action: "update" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news = {} }) {
          const title = yield* createTitle(id, news.title);
          const namespace = yield* createNamespace({
            accountId,
            title,
          }).pipe(
            Effect.catchTag("NamespaceTitleAlreadyExists", () =>
              Effect.gen(function* () {
                const namespaces = yield* listNamespaces({ accountId });
                const match = namespaces.result.find(
                  (ns) => ns.title === title,
                );
                if (match) {
                  return match;
                }
                return yield* Effect.die(
                  `Namespace with title "${title}" already exists but could not be found`,
                );
              }),
            ),
          );
          return {
            title: namespace.title,
            namespaceId: namespace.id,
            supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
            accountId,
          };
        }),
        update: Effect.fn(function* ({ id, news = {}, output }) {
          const title = yield* createTitle(id, news.title);
          const namespace = yield* updateNamespace({
            accountId,
            namespaceId: output.namespaceId,
            title,
          });
          return {
            title: namespace.title,
            namespaceId: namespace.id,
            supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
            accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteNamespace({
            accountId: output.accountId,
            namespaceId: output.namespaceId,
          }).pipe(Effect.catchTag("NamespaceNotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.namespaceId) {
            return yield* getNamespaceFn({
              accountId: output.accountId,
              namespaceId: output.namespaceId,
            }).pipe(
              Effect.map((namespace) => ({
                title: namespace.title,
                namespaceId: namespace.id,
                supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
                accountId: output.accountId,
              })),
              Effect.catchTag("NamespaceNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          const title = yield* createTitle(id, olds?.title);
          const namespaces = yield* listNamespaces({ accountId });
          const match = namespaces.result.find((ns) => ns.title === title);
          if (match) {
            return {
              title: match.title,
              namespaceId: match.id,
              supportsUrlEncoding: match.supportsUrlEncoding ?? undefined,
              accountId,
            };
          }
          return undefined;
        }),
      };
    }),
  );
