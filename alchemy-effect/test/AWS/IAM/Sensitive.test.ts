import * as AWS from "@/AWS";
import { AccessKey, LoginProfile, User } from "@/AWS/IAM";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

describe("AWS.IAM sensitive resources", () => {
  test(
    "create, update, and delete access key plus login profile",
    Effect.gen(function* () {
      yield* destroy();

      const resources = yield* test.deploy(
        Effect.gen(function* () {
          const user = yield* User("CredentialUser", {});
          const accessKey = yield* AccessKey("AccessKey", {
            userName: user.userName,
            status: "Active",
          });
          const loginProfile = yield* LoginProfile("LoginProfile", {
            userName: user.userName,
            password: "TempPassword123!",
            passwordResetRequired: true,
          });
          return { user, accessKey, loginProfile };
        }),
      );

      expect(resources.accessKey.secretAccessKey).toBeDefined();

      yield* test.deploy(
        Effect.gen(function* () {
          const user = yield* User("CredentialUser", {});
          yield* AccessKey("AccessKey", {
            userName: user.userName,
            status: "Inactive",
          });
          yield* LoginProfile("LoginProfile", {
            userName: user.userName,
            password: "UpdatedPassword123!",
            passwordResetRequired: false,
          });
        }),
      );

      const accessKeys = yield* IAM.listAccessKeys({
        UserName: resources.user.userName,
      });
      expect(accessKeys.AccessKeyMetadata[0]?.Status).toBe("Inactive");

      const loginProfile = yield* IAM.getLoginProfile({
        UserName: resources.user.userName,
      });
      expect(loginProfile.LoginProfile.PasswordResetRequired).toBe(false);

      yield* destroy();
    }).pipe(Effect.provide(AWS.providers())),
  );
});
