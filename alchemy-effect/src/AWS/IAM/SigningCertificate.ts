import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export interface SigningCertificateProps {
  /**
   * User that owns the signing certificate.
   */
  userName: string;
  /**
   * X.509 signing certificate body.
   */
  certificateBody: string;
  /**
   * Desired certificate status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface SigningCertificate extends Resource<
  "AWS.IAM.SigningCertificate",
  SigningCertificateProps,
  {
    userName: string;
    certificateId: string;
    certificateBody: string;
    status: iam.StatusType;
    uploadDate: Date | undefined;
  }
> {}

/**
 * An IAM signing certificate for a user.
 *
 * `SigningCertificate` uploads an X.509 signing certificate for legacy
 * IAM-integrated workflows that still depend on user-scoped certificates.
 *
 * @section Managing User Certificates
 * @example Upload a Signing Certificate
 * ```typescript
 * const user = yield* User("Signer", {
 *   userName: "build-signer",
 * });
 *
 * const certificate = yield* SigningCertificate("SigningCertificate", {
 *   userName: user.userName,
 *   certificateBody: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
 * });
 * ```
 */
export const SigningCertificate = Resource<SigningCertificate>(
  "AWS.IAM.SigningCertificate",
);

export const SigningCertificateProvider = () =>
  Provider.succeed(SigningCertificate, {
    stables: ["certificateId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.userName !== news.userName ||
        olds.certificateBody !== news.certificateBody
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const listed = yield* iam.listSigningCertificates({
        UserName: output.userName,
      });
      const cert = listed.Certificates.find(
        (entry) => entry.CertificateId === output.certificateId,
      );
      if (!cert?.CertificateId) {
        return undefined;
      }
      return {
        userName: cert.UserName,
        certificateId: cert.CertificateId,
        certificateBody: cert.CertificateBody,
        status: cert.Status,
        uploadDate: cert.UploadDate,
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const created = yield* iam.uploadSigningCertificate({
        UserName: news.userName,
        CertificateBody: news.certificateBody,
      });
      if (
        news.status !== undefined &&
        created.Certificate.Status !== news.status
      ) {
        yield* iam.updateSigningCertificate({
          UserName: news.userName,
          CertificateId: created.Certificate.CertificateId,
          Status: news.status,
        });
      }
      yield* session.note(created.Certificate.CertificateId);
      return {
        userName: created.Certificate.UserName,
        certificateId: created.Certificate.CertificateId,
        certificateBody: created.Certificate.CertificateBody,
        status: news.status ?? created.Certificate.Status,
        uploadDate: created.Certificate.UploadDate,
      };
    }),
    update: Effect.fn(function* ({ news, output, session }) {
      const status = news.status ?? output.status;
      if (status !== output.status) {
        yield* iam.updateSigningCertificate({
          UserName: output.userName,
          CertificateId: output.certificateId,
          Status: status,
        });
      }
      yield* session.note(output.certificateId);
      return {
        ...output,
        status,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSigningCertificate({
          UserName: output.userName,
          CertificateId: output.certificateId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
