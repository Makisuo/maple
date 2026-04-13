import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface DelegatedAdministratorProps {
  /**
   * Member account registered as delegated administrator.
   */
  accountId: string;
  /**
   * Service principal delegated to the account.
   */
  servicePrincipal: string;
}

export interface DelegatedAdministrator extends Resource<
  "AWS.Organizations.DelegatedAdministrator",
  DelegatedAdministratorProps,
  {
    accountId: string;
    accountArn: string | undefined;
    accountName: organizations.DelegatedAdministrator["Name"] | undefined;
    accountEmail: organizations.DelegatedAdministrator["Email"] | undefined;
    servicePrincipal: string;
    delegationEnabledDate: Date | undefined;
  }
> {}

/**
 * Registers a delegated administrator account for a trusted AWS service.
 */
export const DelegatedAdministrator = Resource<DelegatedAdministrator>(
  "AWS.Organizations.DelegatedAdministrator",
);

export const DelegatedAdministratorProvider = () =>
  Provider.effect(
    DelegatedAdministrator,
    Effect.gen(function* () {
      return {
        stables: ["accountId", "servicePrincipal"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.accountId !== news.accountId ||
            olds?.servicePrincipal !== news.servicePrincipal
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readDelegatedAdministrator({
            accountId: output?.accountId ?? olds!.accountId,
            servicePrincipal:
              output?.servicePrincipal ?? olds!.servicePrincipal,
          });
        }),
        create: Effect.fn(function* ({ news, session }) {
          if (!(yield* readDelegatedAdministrator(news))) {
            yield* retryOrganizations(
              organizations
                .registerDelegatedAdministrator({
                  AccountId: news.accountId,
                  ServicePrincipal: news.servicePrincipal,
                })
                .pipe(
                  Effect.catchTag(
                    "AccountAlreadyRegisteredException",
                    () => Effect.void,
                  ),
                ),
            );
          }

          const state = yield* readDelegatedAdministrator(news);
          if (!state) {
            return yield* Effect.fail(
              new Error(
                `delegated administrator '${news.accountId}' for '${news.servicePrincipal}' not found after create`,
              ),
            );
          }

          yield* session.note(`${state.accountId}:${state.servicePrincipal}`);
          return state;
        }),
        update: Effect.fn(function* ({ output, session }) {
          yield* session.note(`${output.accountId}:${output.servicePrincipal}`);
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (
            !(yield* readDelegatedAdministrator({
              accountId: output.accountId,
              servicePrincipal: output.servicePrincipal,
            }))
          ) {
            return;
          }

          yield* retryOrganizations(
            organizations.deregisterDelegatedAdministrator({
              AccountId: output.accountId,
              ServicePrincipal: output.servicePrincipal,
            }),
          );
        }),
      };
    }),
  );

const readDelegatedAdministrator = Effect.fn(function* ({
  accountId,
  servicePrincipal,
}: DelegatedAdministratorProps) {
  const [delegatedServices, delegatedAdmins] = yield* Effect.all([
    retryOrganizations(
      collectPages(
        (NextToken) =>
          organizations.listDelegatedServicesForAccount({
            AccountId: accountId,
            NextToken,
          }),
        (page) => page.DelegatedServices,
      ),
    ),
    retryOrganizations(
      collectPages(
        (NextToken) =>
          organizations.listDelegatedAdministrators({
            ServicePrincipal: servicePrincipal,
            NextToken,
          }),
        (page) => page.DelegatedAdministrators,
      ),
    ),
  ]);

  const service = delegatedServices.find(
    (candidate) => candidate.ServicePrincipal === servicePrincipal,
  );
  const account = delegatedAdmins.find(
    (candidate) => candidate.Id === accountId,
  );

  return service && account
    ? ({
        accountId,
        accountArn: account.Arn,
        accountName: account.Name,
        accountEmail: account.Email,
        servicePrincipal,
        delegationEnabledDate:
          service.DelegationEnabledDate ?? account.DelegationEnabledDate,
      } satisfies DelegatedAdministrator["Attributes"])
    : undefined;
});
