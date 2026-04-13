import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { diffTags } from "../../Tags.ts";
import { Account } from "../Account.ts";
import { toTagRecord } from "./common.ts";

export interface OpenIDConnectProviderProps {
  /**
   * The identity provider URL.
   */
  url: string;
  /**
   * Client IDs allowed for the provider.
   */
  clientIDList?: string[];
  /**
   * Certificate thumbprints for the provider.
   */
  thumbprintList?: string[];
  /**
   * User-defined tags to apply to the provider.
   */
  tags?: Record<string, string>;
}

export interface OpenIDConnectProvider extends Resource<
  "AWS.IAM.OpenIDConnectProvider",
  OpenIDConnectProviderProps,
  {
    openIDConnectProviderArn: string;
    url: string;
    clientIDList: string[];
    thumbprintList: string[];
    tags: Record<string, string>;
  }
> {}

/**
 * An IAM OpenID Connect provider for web identity federation.
 *
 * `OpenIDConnectProvider` registers an external OIDC issuer so IAM roles can be
 * assumed through web identity federation flows such as GitHub Actions.
 *
 * @section Federating with OIDC
 * @example Create a GitHub Actions OIDC Provider
 * ```typescript
 * const oidc = yield* OpenIDConnectProvider("GithubOidc", {
 *   url: "https://token.actions.githubusercontent.com",
 *   clientIDList: ["sts.amazonaws.com"],
 *   thumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
 * });
 * ```
 */
export const OpenIDConnectProvider = Resource<OpenIDConnectProvider>(
  "AWS.IAM.OpenIDConnectProvider",
);

export const OpenIDConnectProviderProvider = () =>
  Provider.effect(
    OpenIDConnectProvider,
    Effect.gen(function* () {
      const accountId = yield* Account;
      const oidcArnFromUrl = (url: string) =>
        `arn:aws:iam::${accountId}:oidc-provider/${url.replace(/^https?:\/\//, "")}`;

      const readProvider = Effect.fn(function* (providerArn: string) {
        const response = yield* iam
          .getOpenIDConnectProvider({
            OpenIDConnectProviderArn: providerArn,
          })
          .pipe(
            Effect.catchTag("NoSuchEntityException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response;
      });

      return {
        stables: ["openIDConnectProviderArn"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds.url !== news.url) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const providerArn =
            output?.openIDConnectProviderArn ?? oidcArnFromUrl(olds.url);
          const provider = yield* readProvider(providerArn);
          if (!provider?.Url) {
            return undefined;
          }
          const tags = yield* iam.listOpenIDConnectProviderTags({
            OpenIDConnectProviderArn: providerArn,
          });
          return {
            openIDConnectProviderArn: providerArn,
            url: provider.Url,
            clientIDList: provider.ClientIDList ?? [],
            thumbprintList: provider.ThumbprintList ?? [],
            tags: toTagRecord(tags.Tags),
          };
        }),
        create: Effect.fn(function* ({ news, session }) {
          const created = yield* iam.createOpenIDConnectProvider({
            Url: news.url,
            ClientIDList: news.clientIDList,
            ThumbprintList: news.thumbprintList,
            Tags: Object.entries(news.tags ?? {}).map(([Key, Value]) => ({
              Key,
              Value,
            })),
          });

          const providerArn =
            created.OpenIDConnectProviderArn ?? oidcArnFromUrl(news.url);
          yield* session.note(providerArn);
          return {
            openIDConnectProviderArn: providerArn,
            url: news.url,
            clientIDList: news.clientIDList ?? [],
            thumbprintList: news.thumbprintList ?? [],
            tags: news.tags ?? {},
          };
        }),
        update: Effect.fn(function* ({ news, olds, output, session }) {
          const oldClientIds = new Set(olds.clientIDList ?? []);
          const newClientIds = new Set(news.clientIDList ?? []);
          for (const clientId of news.clientIDList ?? []) {
            if (!oldClientIds.has(clientId)) {
              yield* iam.addClientIDToOpenIDConnectProvider({
                OpenIDConnectProviderArn: output.openIDConnectProviderArn,
                ClientID: clientId,
              });
            }
          }
          for (const clientId of olds.clientIDList ?? []) {
            if (!newClientIds.has(clientId)) {
              yield* iam.removeClientIDFromOpenIDConnectProvider({
                OpenIDConnectProviderArn: output.openIDConnectProviderArn,
                ClientID: clientId,
              });
            }
          }
          if (
            JSON.stringify(olds.thumbprintList ?? []) !==
            JSON.stringify(news.thumbprintList ?? [])
          ) {
            yield* iam.updateOpenIDConnectProviderThumbprint({
              OpenIDConnectProviderArn: output.openIDConnectProviderArn,
              ThumbprintList: news.thumbprintList ?? [],
            });
          }

          const { removed, upsert } = diffTags(
            olds.tags ?? {},
            news.tags ?? {},
          );
          if (upsert.length > 0) {
            yield* iam.tagOpenIDConnectProvider({
              OpenIDConnectProviderArn: output.openIDConnectProviderArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* iam.untagOpenIDConnectProvider({
              OpenIDConnectProviderArn: output.openIDConnectProviderArn,
              TagKeys: removed,
            });
          }

          yield* session.note(output.openIDConnectProviderArn);
          return {
            openIDConnectProviderArn: output.openIDConnectProviderArn,
            url: output.url,
            clientIDList: news.clientIDList ?? [],
            thumbprintList: news.thumbprintList ?? [],
            tags: news.tags ?? {},
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iam
            .deleteOpenIDConnectProvider({
              OpenIDConnectProviderArn: output.openIDConnectProviderArn,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }),
      };
    }),
  );
