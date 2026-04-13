import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export interface AccountAliasProps {
  /**
   * The AWS account alias to manage.
   */
  accountAlias: string;
}

export interface AccountAlias extends Resource<
  "AWS.IAM.AccountAlias",
  AccountAliasProps,
  {
    accountAlias: string;
  }
> {}

/**
 * The singleton IAM account alias for an AWS account.
 *
 * `AccountAlias` manages the one account-level alias that customizes the AWS
 * sign-in URL for the current account.
 *
 * @section Managing Account Identity
 * @example Set the Account Alias
 * ```typescript
 * const alias = yield* AccountAlias("AccountAlias", {
 *   accountAlias: "my-company-prod",
 * });
 * ```
 */
export const AccountAlias = Resource<AccountAlias>("AWS.IAM.AccountAlias");

const readAccountAlias = Effect.gen(function* () {
  const response = yield* iam.listAccountAliases({});
  return response.AccountAliases?.[0];
});

export const AccountAliasProvider = () =>
  Provider.succeed(AccountAlias, {
    stables: ["accountAlias"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.accountAlias !== news.accountAlias) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* () {
      const accountAlias = yield* readAccountAlias;
      if (!accountAlias) {
        return undefined;
      }
      return { accountAlias };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const existing = yield* readAccountAlias;
      if (existing && existing !== news.accountAlias) {
        return yield* Effect.fail(
          new Error(
            `Account alias '${existing}' already exists and must be removed before '${news.accountAlias}' can be created`,
          ),
        );
      }
      if (!existing) {
        yield* iam.createAccountAlias({
          AccountAlias: news.accountAlias,
        });
      }
      yield* session.note(news.accountAlias);
      return { accountAlias: news.accountAlias };
    }),
    update: Effect.fn(function* ({ news, olds, session }) {
      if (olds.accountAlias !== news.accountAlias) {
        yield* iam.createAccountAlias({
          AccountAlias: news.accountAlias,
        });
        yield* iam
          .deleteAccountAlias({
            AccountAlias: olds.accountAlias,
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      }
      yield* session.note(news.accountAlias);
      return { accountAlias: news.accountAlias };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteAccountAlias({
          AccountAlias: output.accountAlias,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
