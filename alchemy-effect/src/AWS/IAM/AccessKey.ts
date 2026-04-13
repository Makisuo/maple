import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toRedactedString } from "./common.ts";

export interface AccessKeyProps {
  /**
   * User that owns the access key.
   */
  userName: string;
  /**
   * Desired access key status.
   * @default "Active"
   */
  status?: iam.StatusType;
}

export interface AccessKey extends Resource<
  "AWS.IAM.AccessKey",
  AccessKeyProps,
  {
    userName: string;
    accessKeyId: string;
    status: iam.StatusType;
    createDate: Date | undefined;
    secretAccessKey: Redacted.Redacted<string> | undefined;
    lastUsedDate: Date | undefined;
    lastUsedServiceName: string | undefined;
    lastUsedRegion: string | undefined;
  }
> {}

/**
 * An IAM access key for a user.
 *
 * `AccessKey` manages long-lived programmatic credentials for an IAM user. The
 * secret access key is only returned during creation, so later reads preserve
 * the originally stored redacted value instead of pretending AWS can return it again.
 *
 * @section Managing Programmatic Credentials
 * @example Create an Access Key
 * ```typescript
 * const user = yield* User("DeployUser", {
 *   userName: "deploy-user",
 * });
 *
 * const key = yield* AccessKey("DeployUserKey", {
 *   userName: user.userName,
 *   status: "Active",
 * });
 * ```
 */
export const AccessKey = Resource<AccessKey>("AWS.IAM.AccessKey");

export const AccessKeyProvider = () =>
  Provider.succeed(AccessKey, {
    stables: ["accessKeyId"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.userName !== news.userName) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const listed = yield* iam.listAccessKeys({
        UserName: output.userName,
      });
      const metadata = listed.AccessKeyMetadata.find(
        (entry) => entry.AccessKeyId === output.accessKeyId,
      );
      if (!metadata?.AccessKeyId) {
        return undefined;
      }
      const lastUsed = yield* iam.getAccessKeyLastUsed({
        AccessKeyId: output.accessKeyId,
      });
      return {
        userName: metadata.UserName ?? output.userName,
        accessKeyId: metadata.AccessKeyId,
        status: metadata.Status ?? output.status,
        createDate: metadata.CreateDate,
        secretAccessKey: output.secretAccessKey,
        lastUsedDate: lastUsed?.AccessKeyLastUsed?.LastUsedDate,
        lastUsedServiceName: lastUsed?.AccessKeyLastUsed?.ServiceName,
        lastUsedRegion: lastUsed?.AccessKeyLastUsed?.Region,
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      const created = yield* iam.createAccessKey({
        UserName: news.userName,
      });
      if (
        news.status !== undefined &&
        created.AccessKey.Status !== news.status
      ) {
        yield* iam.updateAccessKey({
          UserName: news.userName,
          AccessKeyId: created.AccessKey.AccessKeyId,
          Status: news.status,
        });
      }
      yield* session.note(created.AccessKey.AccessKeyId);
      return {
        userName: created.AccessKey.UserName,
        accessKeyId: created.AccessKey.AccessKeyId,
        status: news.status ?? created.AccessKey.Status,
        createDate: created.AccessKey.CreateDate,
        secretAccessKey: toRedactedString(created.AccessKey.SecretAccessKey),
        lastUsedDate: undefined,
        lastUsedServiceName: undefined,
        lastUsedRegion: undefined,
      };
    }),
    update: Effect.fn(function* ({ news, output, session }) {
      const status = news.status ?? output.status;
      if (status !== output.status) {
        yield* iam.updateAccessKey({
          UserName: output.userName,
          AccessKeyId: output.accessKeyId,
          Status: status,
        });
      }
      yield* session.note(output.accessKeyId);
      return {
        ...output,
        status,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteAccessKey({
          UserName: output.userName,
          AccessKeyId: output.accessKeyId,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }),
  });
