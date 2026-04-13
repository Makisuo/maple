import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";

export interface SSHPublicKeyProps {
  /**
   * User that owns the SSH public key.
   */
  userName: string;
  /**
   * SSH public key body.
   */
  sshPublicKeyBody: string;
  /**
   * Desired key status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface SSHPublicKey extends Resource<
  "AWS.IAM.SSHPublicKey",
  SSHPublicKeyProps,
  {
    userName: string;
    sshPublicKeyId: string;
    fingerprint: string;
    sshPublicKeyBody: string;
    status: iam.StatusType;
    uploadDate: Date | undefined;
  }
> {}

/**
 * An IAM SSH public key for CodeCommit-compatible workflows.
 *
 * `SSHPublicKey` uploads and manages a user's public key for services such as
 * AWS CodeCommit that authenticate through IAM-backed SSH credentials.
 *
 * @section Managing SSH Keys
 * @example Upload an SSH Public Key
 * ```typescript
 * const user = yield* User("GitUser", {
 *   userName: "codecommit-user",
 * });
 *
 * const key = yield* SSHPublicKey("GitKey", {
 *   userName: user.userName,
 *   sshPublicKeyBody: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample codecommit-user",
 * });
 * ```
 */
export const SSHPublicKey = Resource<SSHPublicKey>("AWS.IAM.SSHPublicKey");

export const SSHPublicKeyProvider = () =>
  Provider.succeed(SSHPublicKey, {
    stables: ["sshPublicKeyId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (
        olds.userName !== news.userName ||
        olds.sshPublicKeyBody !== news.sshPublicKeyBody
      ) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const response = yield* iam
        .getSSHPublicKey({
          UserName: output.userName,
          SSHPublicKeyId: output.sshPublicKeyId,
          Encoding: "SSH",
        })
        .pipe(
          Effect.catchTag("NoSuchEntityException", () =>
            Effect.succeed(undefined),
          ),
        );
      if (!response?.SSHPublicKey?.SSHPublicKeyId) {
        return undefined;
      }
      return {
        userName: response.SSHPublicKey.UserName,
        sshPublicKeyId: response.SSHPublicKey.SSHPublicKeyId,
        fingerprint: response.SSHPublicKey.Fingerprint,
        sshPublicKeyBody: response.SSHPublicKey.SSHPublicKeyBody,
        status: response.SSHPublicKey.Status,
        uploadDate: response.SSHPublicKey.UploadDate,
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const created = yield* iam.uploadSSHPublicKey({
        UserName: news.userName,
        SSHPublicKeyBody: news.sshPublicKeyBody,
      });
      if (!created.SSHPublicKey?.SSHPublicKeyId) {
        return yield* Effect.fail(
          new Error(`uploadSSHPublicKey returned no key id`),
        );
      }
      if (
        news.status !== undefined &&
        created.SSHPublicKey.Status !== news.status
      ) {
        yield* iam.updateSSHPublicKey({
          UserName: news.userName,
          SSHPublicKeyId: created.SSHPublicKey.SSHPublicKeyId,
          Status: news.status,
        });
      }
      yield* session.note(created.SSHPublicKey.SSHPublicKeyId);
      return {
        userName: created.SSHPublicKey.UserName,
        sshPublicKeyId: created.SSHPublicKey.SSHPublicKeyId,
        fingerprint: created.SSHPublicKey.Fingerprint,
        sshPublicKeyBody: created.SSHPublicKey.SSHPublicKeyBody,
        status: news.status ?? created.SSHPublicKey.Status,
        uploadDate: created.SSHPublicKey.UploadDate,
      };
    }),
    update: Effect.fn(function* ({ news, output, session }) {
      const status = news.status ?? output.status;
      if (status !== output.status) {
        yield* iam.updateSSHPublicKey({
          UserName: output.userName,
          SSHPublicKeyId: output.sshPublicKeyId,
          Status: status,
        });
      }
      yield* session.note(output.sshPublicKeyId);
      return {
        ...output,
        status,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteSSHPublicKey({
          UserName: output.userName,
          SSHPublicKeyId: output.sshPublicKeyId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
