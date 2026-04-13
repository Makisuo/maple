import * as accountManagement from "@distilled.cloud/aws/account";
import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  collectPages,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type AccountId = string;
export type AccountArn = string;

export interface AccountProps {
  /**
   * Account email. Must be globally unique across AWS accounts.
   */
  email: string;
  /**
   * Friendly account name.
   */
  name: string;
  /**
   * Parent root or OU ID.
   */
  parentId: string;
  /**
   * Optional cross-account access role name created during account vending.
   */
  roleName?: string;
  /**
   * Whether IAM users can access billing information.
   */
  iamUserAccessToBilling?: organizations.IAMUserAccessToBilling;
  /**
   * Optional tags applied to the member account while it remains in the org.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "AWS.Organizations.Account",
  AccountProps,
  {
    accountId: AccountId;
    accountArn: AccountArn;
    name: organizations.Account["Name"] | undefined;
    email: organizations.Account["Email"] | undefined;
    parentId: string | undefined;
    status: organizations.AccountStatus | undefined;
    state: organizations.AccountState | undefined;
    joinedMethod: organizations.AccountJoinedMethod | undefined;
    joinedTimestamp: Date | undefined;
    tags: Record<string, string>;
  }
> {}

/**
 * A member account created and managed by AWS Organizations.
 */
export const Account = Resource<Account>("AWS.Organizations.Account");

export const AccountProvider = () =>
  Provider.effect(
    Account,
    Effect.gen(function* () {
      return {
        stables: ["accountId", "accountArn", "joinedMethod", "joinedTimestamp"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.email !== news.email) {
            return { action: "replace" } as const;
          }
          if (olds?.name !== news.name) {
            return { action: "update" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output?.accountId) {
            return yield* readAccountById(output.accountId);
          }

          if (!olds) {
            return undefined;
          }

          return yield* readAccountByNameOrEmail({
            name: olds.name,
            email: olds.email,
          });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const existing = yield* readAccountByNameOrEmail({
            name: news.name,
            email: news.email,
          });

          if (existing) {
            yield* ensureOwnedByAlchemy(
              id,
              existing.accountId,
              existing.tags,
              "account",
            );
          } else {
            const createResponse = yield* retryOrganizations(
              organizations.createAccount({
                Email: news.email,
                AccountName: news.name,
                RoleName: news.roleName,
                IamUserAccessToBilling: news.iamUserAccessToBilling,
              }),
            );

            const requestId = createResponse.CreateAccountStatus?.Id;
            if (requestId) {
              const status = yield* waitForCreateAccount(requestId);
              yield* session.note(status.AccountId ?? requestId);
            }
          }

          let created = yield* readAccountByNameOrEmail({
            name: news.name,
            email: news.email,
          });

          if (!created) {
            return yield* Effect.fail(
              new Error(`account '${news.name}' not found after create`),
            );
          }

          if (created.parentId !== news.parentId && created.parentId) {
            yield* retryOrganizations(
              organizations.moveAccount({
                AccountId: created.accountId,
                SourceParentId: created.parentId,
                DestinationParentId: news.parentId,
              }),
            );
            created = (yield* readAccountById(created.accountId)) ?? created;
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: created.accountId,
            olds: created.tags,
            news: news.tags,
          });

          yield* session.note(created.accountArn);
          return {
            ...created,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          if (output.name !== news.name) {
            yield* retryAccountManagement(
              accountManagement.putAccountName({
                AccountId: output.accountId,
                AccountName: news.name,
              }),
            );
          }

          if (output.parentId && output.parentId !== news.parentId) {
            yield* retryOrganizations(
              organizations.moveAccount({
                AccountId: output.accountId,
                SourceParentId: output.parentId,
                DestinationParentId: news.parentId,
              }),
            );
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: output.accountId,
            olds: olds.tags,
            news: news.tags,
          });

          const updated = yield* readAccountById(output.accountId);
          if (!updated) {
            return yield* Effect.fail(
              new Error(`account '${output.accountId}' not found after update`),
            );
          }

          yield* session.note(output.accountArn);
          return {
            ...updated,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .removeAccountFromOrganization({
                AccountId: output.accountId,
              })
              .pipe(
                Effect.catchTags({
                  AccountNotFoundException: () => Effect.void,
                  AWSOrganizationsNotInUseException: () => Effect.void,
                }),
              ),
          );
        }),
      };
    }),
  );

const listAccounts = () =>
  collectPages(
    (NextToken) => organizations.listAccounts({ NextToken }),
    (page) => page.Accounts,
  ).pipe(retryOrganizations);

const readParentId = (childId: string) =>
  collectPages(
    (NextToken) => organizations.listParents({ ChildId: childId, NextToken }),
    (page) => page.Parents,
  ).pipe(
    retryOrganizations,
    Effect.map((parents) => parents[0]?.Id),
    Effect.catchTag("ChildNotFoundException", () => Effect.succeed(undefined)),
  );

const readAccountById = Effect.fn(function* (accountId: string) {
  const described = yield* retryOrganizations(
    organizations.describeAccount({ AccountId: accountId }).pipe(
      Effect.map((response) => response.Account),
      Effect.catchTag("AccountNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
  );

  if (!described?.Id || !described.Arn) {
    return undefined;
  }

  const [parentId, tags] = yield* Effect.all([
    readParentId(described.Id),
    readResourceTags(described.Id).pipe(
      Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
    ),
  ]);

  return {
    accountId: described.Id,
    accountArn: described.Arn,
    name: described.Name,
    email: described.Email,
    parentId,
    status: described.Status,
    state: described.State,
    joinedMethod: described.JoinedMethod,
    joinedTimestamp: described.JoinedTimestamp,
    tags,
  } satisfies Account["Attributes"];
});

const readAccountByNameOrEmail = Effect.fn(function* ({
  name,
  email,
}: Pick<AccountProps, "name" | "email">) {
  const accounts = yield* listAccounts();
  const match = accounts.find(
    (candidate) => candidate.Name === name || candidate.Email === email,
  );
  return match?.Id ? yield* readAccountById(match.Id) : undefined;
});

const waitForCreateAccount = (requestId: string) =>
  Effect.gen(function* () {
    const status = yield* retryOrganizations(
      organizations
        .describeCreateAccountStatus({
          CreateAccountRequestId: requestId,
        })
        .pipe(Effect.map((response) => response.CreateAccountStatus)),
    );

    if (!status?.State || status.State === "IN_PROGRESS") {
      return yield* Effect.fail({ _tag: "CreateAccountInProgress" as const });
    }

    if (status.State === "FAILED") {
      return yield* Effect.fail(
        new Error(
          `account creation failed: ${status.FailureReason ?? "unknown failure"}`,
        ),
      );
    }

    if (!status.AccountId) {
      return yield* Effect.fail(
        new Error("account creation succeeded without AccountId"),
      );
    }

    return status;
  }).pipe(
    Effect.retry({
      while: (error: any) => error?._tag === "CreateAccountInProgress",
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.both(Schedule.recurs(120)),
      ),
    }),
  );

const retryAccountManagement = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error: any) =>
        error?._tag === "TooManyRequestsException" ||
        error?._tag === "InternalServerException",
      schedule: Schedule.exponential(200).pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );
