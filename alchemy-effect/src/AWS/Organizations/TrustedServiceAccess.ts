import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface TrustedServiceAccessProps {
  /**
   * Service principal granted trusted access to the organization.
   */
  servicePrincipal: string;
}

export interface TrustedServiceAccess extends Resource<
  "AWS.Organizations.TrustedServiceAccess",
  TrustedServiceAccessProps,
  {
    servicePrincipal: string;
    dateEnabled: Date | undefined;
  }
> {}

/**
 * Enables trusted access for an AWS service principal.
 */
export const TrustedServiceAccess = Resource<TrustedServiceAccess>(
  "AWS.Organizations.TrustedServiceAccess",
);

export const TrustedServiceAccessProvider = () =>
  Provider.effect(
    TrustedServiceAccess,
    Effect.gen(function* () {
      return {
        stables: ["servicePrincipal"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.servicePrincipal !== news.servicePrincipal) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readTrustedServiceAccess(
            output?.servicePrincipal ?? olds!.servicePrincipal,
          );
        }),
        create: Effect.fn(function* ({ news, session }) {
          if (!(yield* readTrustedServiceAccess(news.servicePrincipal))) {
            yield* retryOrganizations(
              organizations.enableAWSServiceAccess({
                ServicePrincipal: news.servicePrincipal,
              }),
            );
          }

          const state = yield* readTrustedServiceAccess(news.servicePrincipal);
          if (!state) {
            return yield* Effect.fail(
              new Error(
                `trusted service access '${news.servicePrincipal}' not found after create`,
              ),
            );
          }

          yield* session.note(state.servicePrincipal);
          return state;
        }),
        update: Effect.fn(function* ({ output, session }) {
          yield* session.note(output.servicePrincipal);
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!(yield* readTrustedServiceAccess(output.servicePrincipal))) {
            return;
          }

          yield* retryOrganizations(
            organizations.disableAWSServiceAccess({
              ServicePrincipal: output.servicePrincipal,
            }),
          );
        }),
      };
    }),
  );

const readTrustedServiceAccess = Effect.fn(function* (
  servicePrincipal: string,
) {
  const principals = yield* retryOrganizations(
    collectPages(
      (NextToken) =>
        organizations.listAWSServiceAccessForOrganization({ NextToken }),
      (page) => page.EnabledServicePrincipals,
    ),
  );

  const match = principals.find(
    (candidate) => candidate.ServicePrincipal === servicePrincipal,
  );

  return match
    ? ({
        servicePrincipal,
        dateEnabled: match.DateEnabled,
      } satisfies TrustedServiceAccess["Attributes"])
    : undefined;
});
