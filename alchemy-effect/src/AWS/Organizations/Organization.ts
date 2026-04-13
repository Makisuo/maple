import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { retryOrganizations } from "./common.ts";

export type OrganizationId = string;
export type OrganizationArn = string;

export interface OrganizationProps {
  /**
   * Organization feature set.
   * `ALL` unlocks the full AWS Organizations feature set.
   * @default "ALL"
   */
  featureSet?: organizations.OrganizationFeatureSet;
}

export interface Organization extends Resource<
  "AWS.Organizations.Organization",
  OrganizationProps,
  {
    organizationId: OrganizationId;
    organizationArn: OrganizationArn;
    featureSet: organizations.OrganizationFeatureSet | undefined;
    managementAccountArn: string | undefined;
    managementAccountId: string | undefined;
    managementAccountEmail:
      | organizations.Organization["MasterAccountEmail"]
      | undefined;
    availablePolicyTypes: organizations.PolicyTypeSummary[];
  }
> {}

/**
 * The AWS Organization for the current management account.
 *
 * This is a singleton-style resource. If an organization already exists,
 * Alchemy adopts and reconciles it instead of creating a second one.
 *
 * @section Creating An Organization
 * @example Full Features Organization
 * ```typescript
 * const organization = yield* Organization("Org", {
 *   featureSet: "ALL",
 * });
 * ```
 */
export const Organization = Resource<Organization>(
  "AWS.Organizations.Organization",
);

export const OrganizationProvider = () =>
  Provider.effect(
    Organization,
    Effect.gen(function* () {
      return {
        stables: ["organizationId", "organizationArn", "managementAccountId"],
        diff: Effect.fn(function* () {}),
        read: Effect.fn(function* () {
          const org = yield* readOrganization();
          return org?.Id && org.Arn ? toAttrs(org) : undefined;
        }),
        create: Effect.fn(function* ({ news, session }) {
          const desiredFeatureSet = news.featureSet ?? "ALL";
          const existing = yield* readOrganization();
          const org = existing
            ? yield* ensureFeatureSet({
                desired: desiredFeatureSet,
                current: existing,
              })
            : yield* retryOrganizations(
                organizations.createOrganization({
                  FeatureSet: desiredFeatureSet,
                }),
              ).pipe(
                Effect.map((response) => response.Organization),
                Effect.catchTag("AlreadyInOrganizationException", () =>
                  readOrganization(),
                ),
              );

          if (!org?.Id || !org.Arn) {
            return yield* Effect.fail(
              new Error("failed to resolve organization after create"),
            );
          }

          yield* session.note(org.Arn);
          return toAttrs(org);
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          const current = yield* readOrganization();
          if (!current?.Id || !current.Arn) {
            return yield* Effect.fail(
              new Error("organization not found during update"),
            );
          }

          const updated = yield* ensureFeatureSet({
            desired: news.featureSet,
            current,
          });

          yield* session.note(output.organizationArn);
          return toAttrs(updated);
        }),
        delete: Effect.fn(function* () {
          yield* retryOrganizations(
            organizations
              .deleteOrganization({})
              .pipe(
                Effect.catchTag(
                  "AWSOrganizationsNotInUseException",
                  () => Effect.void,
                ),
              ),
          );
        }),
      };
    }),
  );

const toAttrs = (
  org: organizations.Organization,
): Organization["Attributes"] => ({
  organizationId: org.Id ?? "",
  organizationArn: org.Arn ?? "",
  featureSet: org.FeatureSet,
  managementAccountArn: org.MasterAccountArn,
  managementAccountId: org.MasterAccountId,
  managementAccountEmail: org.MasterAccountEmail,
  availablePolicyTypes: org.AvailablePolicyTypes ?? [],
});

const readOrganization = () =>
  retryOrganizations(
    organizations.describeOrganization({}).pipe(
      Effect.map((response) => response.Organization),
      Effect.catchTag("AWSOrganizationsNotInUseException", () =>
        Effect.succeed(undefined),
      ),
    ),
  );

const ensureFeatureSet = Effect.fn(function* ({
  desired,
  current,
}: {
  desired: organizations.OrganizationFeatureSet | undefined;
  current: organizations.Organization;
}) {
  const desiredFeatureSet = desired ?? "ALL";
  if (current.FeatureSet === desiredFeatureSet) {
    return current;
  }

  if (
    desiredFeatureSet === "ALL" &&
    current.FeatureSet === "CONSOLIDATED_BILLING"
  ) {
    yield* retryOrganizations(organizations.enableAllFeatures({}));

    const updated = yield* readOrganization();
    if (updated?.FeatureSet === "ALL") {
      return updated;
    }

    return yield* Effect.fail(
      new Error(
        "Organization upgrade to ALL features requires handshake completion before deployment can converge",
      ),
    );
  }

  return yield* Effect.fail(
    new Error(
      `Organization feature set cannot be changed from '${current.FeatureSet}' to '${desiredFeatureSet}'`,
    ),
  );
});
