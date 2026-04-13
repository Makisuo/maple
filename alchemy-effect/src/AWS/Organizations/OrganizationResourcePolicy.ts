import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import { retryOrganizations } from "./common.ts";

export interface OrganizationResourcePolicyProps {
  /**
   * Typed resource policy document for the organization.
   */
  document: PolicyDocument;
}

export interface OrganizationResourcePolicy extends Resource<
  "AWS.Organizations.OrganizationResourcePolicy",
  OrganizationResourcePolicyProps,
  {
    resourcePolicyId: string;
    resourcePolicyArn: string;
    document: PolicyDocument;
  }
> {}

/**
 * The singleton AWS Organizations resource policy.
 */
export const OrganizationResourcePolicy = Resource<OrganizationResourcePolicy>(
  "AWS.Organizations.OrganizationResourcePolicy",
);

const readResourcePolicy = () =>
  retryOrganizations(
    organizations.describeResourcePolicy({}).pipe(
      Effect.map((response) => response.ResourcePolicy),
      Effect.catchTag("ResourcePolicyNotFoundException", () =>
        Effect.succeed(undefined),
      ),
      Effect.map((policy) => {
        const summary = policy?.ResourcePolicySummary;
        return summary?.Id && summary.Arn
          ? ({
              resourcePolicyId: summary.Id,
              resourcePolicyArn: summary.Arn,
              document: JSON.parse(policy?.Content ?? "{}") as PolicyDocument,
            } satisfies OrganizationResourcePolicy["Attributes"])
          : undefined;
      }),
    ),
  );

export const OrganizationResourcePolicyProvider = () =>
  Provider.effect(
    OrganizationResourcePolicy,
    Effect.gen(function* () {
      return {
        stables: ["resourcePolicyId", "resourcePolicyArn"],
        diff: Effect.fn(function* () {}),
        read: Effect.fn(function* () {
          return yield* readResourcePolicy();
        }),
        create: Effect.fn(function* ({ news, session }) {
          yield* retryOrganizations(
            organizations.putResourcePolicy({
              Content: JSON.stringify(news.document),
            }),
          );

          const state = yield* readResourcePolicy();
          if (!state) {
            return yield* Effect.fail(
              new Error("organization resource policy not found after create"),
            );
          }

          yield* session.note(state.resourcePolicyArn);
          return state;
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          yield* retryOrganizations(
            organizations.putResourcePolicy({
              Content: JSON.stringify(news.document),
            }),
          );

          const state = yield* readResourcePolicy();
          if (!state) {
            return yield* Effect.fail(
              new Error("organization resource policy not found after update"),
            );
          }

          yield* session.note(output.resourcePolicyArn);
          return state;
        }),
        delete: Effect.fn(function* () {
          yield* retryOrganizations(
            organizations
              .deleteResourcePolicy({})
              .pipe(
                Effect.catchTag(
                  "ResourcePolicyNotFoundException",
                  () => Effect.void,
                ),
              ),
          );
        }),
      };
    }),
  );
