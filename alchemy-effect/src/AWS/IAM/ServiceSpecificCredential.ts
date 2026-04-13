import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toRedactedString } from "./common.ts";

export interface ServiceSpecificCredentialProps {
  /**
   * User that owns the service-specific credential.
   */
  userName: string;
  /**
   * AWS service name that will consume the credential.
   */
  serviceName: string;
  /**
   * Optional credential age in days.
   */
  credentialAgeDays?: number;
  /**
   * Desired credential status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface ServiceSpecificCredential extends Resource<
  "AWS.IAM.ServiceSpecificCredential",
  ServiceSpecificCredentialProps,
  {
    userName: string;
    serviceName: string;
    serviceSpecificCredentialId: string;
    status: iam.StatusType;
    createDate: Date | undefined;
    expirationDate: Date | undefined;
    serviceUserName: string | undefined;
    serviceCredentialAlias: string | undefined;
    servicePassword: Redacted.Redacted<string> | undefined;
    serviceCredentialSecret: Redacted.Redacted<string> | undefined;
  }
> {}

/**
 * A service-specific IAM credential.
 *
 * `ServiceSpecificCredential` creates service-bound credentials such as
 * CodeCommit HTTPS passwords for an IAM user. AWS only returns the secret
 * fields during creation, so subsequent reads preserve the originally stored
 * redacted values.
 *
 * @section Managing Service Credentials
 * @example Create a CodeCommit Credential
 * ```typescript
 * const user = yield* User("CodeCommitUser", {
 *   userName: "codecommit-user",
 * });
 *
 * const credential = yield* ServiceSpecificCredential("CodeCommitCredential", {
 *   userName: user.userName,
 *   serviceName: "codecommit.amazonaws.com",
 * });
 * ```
 */
export const ServiceSpecificCredential = Resource<ServiceSpecificCredential>(
  "AWS.IAM.ServiceSpecificCredential",
);

export const ServiceSpecificCredentialProvider = () =>
  Provider.succeed(ServiceSpecificCredential, {
    stables: ["serviceSpecificCredentialId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.userName !== news.userName ||
        olds.serviceName !== news.serviceName ||
        olds.credentialAgeDays !== news.credentialAgeDays
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const listed = yield* iam.listServiceSpecificCredentials({
        UserName: output.userName,
        ServiceName: output.serviceName,
      });
      const metadata = listed.ServiceSpecificCredentials?.find(
        (entry) =>
          entry.ServiceSpecificCredentialId ===
          output.serviceSpecificCredentialId,
      );
      if (!metadata?.ServiceSpecificCredentialId) {
        return undefined;
      }
      return {
        userName: metadata.UserName,
        serviceName: metadata.ServiceName,
        serviceSpecificCredentialId: metadata.ServiceSpecificCredentialId,
        status: metadata.Status,
        createDate: metadata.CreateDate,
        expirationDate: metadata.ExpirationDate,
        serviceUserName: metadata.ServiceUserName,
        serviceCredentialAlias: metadata.ServiceCredentialAlias,
        servicePassword: output.servicePassword,
        serviceCredentialSecret: output.serviceCredentialSecret,
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const created = yield* iam.createServiceSpecificCredential({
        UserName: news.userName,
        ServiceName: news.serviceName,
        CredentialAgeDays: news.credentialAgeDays,
      });
      const credential = created.ServiceSpecificCredential;
      if (!credential?.ServiceSpecificCredentialId) {
        return yield* Effect.fail(
          new Error(
            `createServiceSpecificCredential returned no credential id`,
          ),
        );
      }
      if (news.status !== undefined && credential.Status !== news.status) {
        yield* iam.updateServiceSpecificCredential({
          UserName: news.userName,
          ServiceSpecificCredentialId: credential.ServiceSpecificCredentialId,
          Status: news.status,
        });
      }
      yield* session.note(credential.ServiceSpecificCredentialId);
      return {
        userName: credential.UserName,
        serviceName: credential.ServiceName,
        serviceSpecificCredentialId: credential.ServiceSpecificCredentialId,
        status: news.status ?? credential.Status,
        createDate: credential.CreateDate,
        expirationDate: credential.ExpirationDate,
        serviceUserName: credential.ServiceUserName,
        serviceCredentialAlias: credential.ServiceCredentialAlias,
        servicePassword: toRedactedString(credential.ServicePassword),
        serviceCredentialSecret: toRedactedString(
          credential.ServiceCredentialSecret,
        ),
      };
    }),
    update: Effect.fn(function* ({ news, output, session }) {
      const status = news.status ?? output.status;
      if (status !== output.status) {
        yield* iam.updateServiceSpecificCredential({
          UserName: output.userName,
          ServiceSpecificCredentialId: output.serviceSpecificCredentialId,
          Status: status,
        });
      }
      yield* session.note(output.serviceSpecificCredentialId);
      return {
        ...output,
        status,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteServiceSpecificCredential({
          UserName: output.userName,
          ServiceSpecificCredentialId: output.serviceSpecificCredentialId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
