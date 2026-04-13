import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { collectPages, retryOrganizations } from "./common.ts";

export interface RootPolicyTypeProps {
  /**
   * Root that owns the enabled policy type.
   */
  rootId: string;
  /**
   * Policy type to enable on the root.
   */
  policyType: organizations.PolicyType;
}

export interface RootPolicyType extends Resource<
  "AWS.Organizations.RootPolicyType",
  RootPolicyTypeProps,
  {
    rootId: string;
    rootArn: string | undefined;
    policyType: organizations.PolicyType;
    status: organizations.PolicyTypeStatus | undefined;
  }
> {}

/**
 * Enables a policy type on an organization root.
 */
export const RootPolicyType = Resource<RootPolicyType>(
  "AWS.Organizations.RootPolicyType",
);

export const RootPolicyTypeProvider = () =>
  Provider.effect(
    RootPolicyType,
    Effect.gen(function* () {
      return {
        stables: ["rootId", "rootArn", "policyType"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            olds?.rootId !== news.rootId ||
            olds?.policyType !== news.policyType
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          return yield* readRootPolicyType({
            rootId: output?.rootId ?? olds!.rootId,
            policyType: output?.policyType ?? olds!.policyType,
          });
        }),
        create: Effect.fn(function* ({ news, session }) {
          yield* retryOrganizations(
            organizations
              .enablePolicyType({
                RootId: news.rootId,
                PolicyType: news.policyType,
              })
              .pipe(
                Effect.catchTag(
                  "PolicyTypeAlreadyEnabledException",
                  () => Effect.void,
                ),
              ),
          );

          const state = yield* readRootPolicyType(news);
          if (!state) {
            return {
              rootId: news.rootId,
              rootArn: undefined,
              policyType: news.policyType,
              status: "PENDING_ENABLE",
            } satisfies RootPolicyType["Attributes"];
          }

          yield* session.note(state.rootArn ?? state.rootId);
          return state;
        }),
        update: Effect.fn(function* ({ output, session }) {
          yield* session.note(output.rootArn ?? output.rootId);
          return output;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryOrganizations(
            organizations
              .disablePolicyType({
                RootId: output.rootId,
                PolicyType: output.policyType,
              })
              .pipe(
                Effect.catchTags({
                  PolicyTypeNotEnabledException: () => Effect.void,
                  RootNotFoundException: () => Effect.void,
                }),
              ),
          );
        }),
      };
    }),
  );

const readRoot = (rootId: string) =>
  collectPages(
    (NextToken) => organizations.listRoots({ NextToken }),
    (page) => page.Roots,
  ).pipe(
    retryOrganizations,
    Effect.map((roots) => roots.find((root) => root.Id === rootId)),
  );

const readRootPolicyType = Effect.fn(function* ({
  rootId,
  policyType,
}: RootPolicyTypeProps) {
  const root = yield* readRoot(rootId);
  const summary = root?.PolicyTypes?.find((item) => item.Type === policyType);
  return summary
    ? ({
        rootId,
        rootArn: root?.Arn,
        policyType,
        status: summary.Status,
      } satisfies RootPolicyType["Attributes"])
    : undefined;
});
