import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import {
  collectPages,
  createName,
  ensureOwnedByAlchemy,
  readResourceTags,
  retryOrganizations,
  updateResourceTags,
} from "./common.ts";

export type PolicyId = string;
export type PolicyArn = string;

export interface PolicyProps {
  /**
   * Policy name. If omitted, Alchemy generates one.
   */
  name?: string;
  /**
   * Policy description.
   * @default ""
   */
  description?: string;
  /**
   * Organizations policy type.
   */
  type: organizations.PolicyType;
  /**
   * Typed policy document.
   */
  document: PolicyDocument;
  /**
   * Optional tags applied to the policy.
   */
  tags?: Record<string, string>;
}

export interface Policy extends Resource<
  "AWS.Organizations.Policy",
  PolicyProps,
  {
    policyId: PolicyId;
    policyArn: PolicyArn;
    name: string;
    description: string | undefined;
    type: organizations.PolicyType | undefined;
    awsManaged: boolean | undefined;
    document: PolicyDocument;
    tags: Record<string, string>;
  }
> {}

/**
 * An AWS Organizations policy such as an SCP or tag policy.
 */
export const Policy = Resource<Policy>("AWS.Organizations.Policy");

export const PolicyProvider = () =>
  Provider.effect(
    Policy,
    Effect.gen(function* () {
      return {
        stables: ["policyId", "policyArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds?.type !== news.type) {
            return { action: "replace" } as const;
          }

          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.policyId) {
            return yield* readPolicyById(output.policyId);
          }

          if (!olds) {
            return undefined;
          }

          return yield* readPolicyByName({
            type: olds.type,
            name: yield* toName(id, olds),
          });
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const existing = yield* readPolicyByName({
            type: news.type,
            name,
          });

          if (existing) {
            yield* ensureOwnedByAlchemy(
              id,
              existing.policyId,
              existing.tags,
              "policy",
            );
          } else {
            yield* retryOrganizations(
              organizations
                .createPolicy({
                  Name: name,
                  Description: news.description ?? "",
                  Type: news.type,
                  Content: JSON.stringify(news.document),
                })
                .pipe(
                  Effect.catchTag(
                    "DuplicatePolicyException",
                    () => Effect.void,
                  ),
                ),
            );
          }

          const created = yield* readPolicyByName({
            type: news.type,
            name,
          });
          if (!created) {
            return yield* Effect.fail(
              new Error(`policy '${name}' not found after create`),
            );
          }

          const tags = yield* updateResourceTags({
            id,
            resourceId: created.policyId,
            olds: created.tags,
            news: news.tags,
          });

          yield* session.note(created.policyArn);
          return {
            ...created,
            tags,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* retryOrganizations(
            organizations.updatePolicy({
              PolicyId: output.policyId,
              Name: output.name,
              Description: news.description ?? "",
              Content: JSON.stringify(news.document),
            }),
          );

          const tags = yield* updateResourceTags({
            id,
            resourceId: output.policyId,
            olds: olds.tags,
            news: news.tags,
          });

          const updated = yield* readPolicyById(output.policyId);
          if (!updated) {
            return yield* Effect.fail(
              new Error(`policy '${output.policyId}' not found after update`),
            );
          }

          yield* session.note(output.policyArn);
          return {
            ...updated,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .deletePolicy({ PolicyId: output.policyId })
              .pipe(
                Effect.catchTag("PolicyNotFoundException", () => Effect.void),
              ),
          );
        }),
      };
    }),
  );

const toName = (id: string, props: { name?: string } = {}) =>
  createName(id, props.name, 128);

const readPolicyById = Effect.fn(function* (policyId: string) {
  const described = yield* retryOrganizations(
    organizations.describePolicy({ PolicyId: policyId }).pipe(
      Effect.map((response) => response.Policy),
      Effect.catchTag("PolicyNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    ),
  );

  const summary = described?.PolicySummary;
  if (!summary?.Id || !summary.Arn || !summary.Name) {
    return undefined;
  }

  const tags = yield* readResourceTags(summary.Id).pipe(
    Effect.catchTag("TargetNotFoundException", () => Effect.succeed({})),
  );

  return {
    policyId: summary.Id,
    policyArn: summary.Arn,
    name: summary.Name,
    description: summary.Description,
    type: summary.Type,
    awsManaged: summary.AwsManaged,
    document: JSON.parse(described?.Content ?? "{}") as PolicyDocument,
    tags,
  } satisfies Policy["Attributes"];
});

const readPolicyByName = Effect.fn(function* ({
  type,
  name,
}: {
  type: organizations.PolicyType;
  name: string;
}) {
  const policies = yield* retryOrganizations(
    collectPages(
      (NextToken) => organizations.listPolicies({ Filter: type, NextToken }),
      (page) => page.Policies,
    ),
  );

  const match = policies.find((policy) => policy.Name === name);
  return match?.Id ? yield* readPolicyById(match.Id) : undefined;
});
