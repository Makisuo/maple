import * as AWS from "@/AWS";
import { Group, GroupMembership, InstanceProfile, Role, User } from "@/AWS/IAM";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

test(
  "create user, group membership, and instance profile",
  Effect.gen(function* () {
    yield* destroy();

    const resources = yield* test.deploy(
      Effect.gen(function* () {
        const role = yield* Role("ProfileRole", {
          assumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: ["sts:AssumeRole"],
              },
            ],
          },
        });
        const user = yield* User("IamUser", {
          tags: {
            env: "test",
          },
        });
        const group = yield* Group("IamGroup", {});
        const membership = yield* GroupMembership("IamMembership", {
          groupName: group.groupName,
          userNames: [user.userName],
        });
        const profile = yield* InstanceProfile("IamInstanceProfile", {
          roleName: role.roleName,
          tags: {
            env: "test",
          },
        });

        return { user, group, membership, profile, role };
      }),
    );

    const group = yield* IAM.getGroup({
      GroupName: resources.group.groupName,
    });
    expect(
      group.Users.some((user) => user.UserName === resources.user.userName),
    ).toBe(true);

    const profile = yield* IAM.getInstanceProfile({
      InstanceProfileName: resources.profile.instanceProfileName,
    });
    expect(profile.InstanceProfile.Roles[0]?.RoleName).toBe(
      resources.role.roleName,
    );

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())),
);
