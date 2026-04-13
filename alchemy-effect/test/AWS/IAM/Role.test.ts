import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: {
        Service: "lambda.amazonaws.com",
      },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test(
  "create, update, and delete role",
  Effect.gen(function* () {
    yield* destroy();

    const role = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogGroup"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "test",
          },
        });
      }),
    );

    const created = yield* IAM.getRole({
      RoleName: role.roleName,
    });
    expect(created.Role.RoleName).toBe(role.roleName);

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Role("IamRole", {
          assumeRolePolicyDocument: assumeRolePolicy,
          managedPolicyArns: [],
          inlinePolicies: {
            AllowLogs: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream"],
                  Resource: "*",
                },
              ],
            },
          },
          tags: {
            env: "prod",
          },
        });
      }),
    );

    const updatedTags = yield* IAM.listRoleTags({
      RoleName: role.roleName,
    });
    expect(
      Object.fromEntries(
        (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      ),
    ).toMatchObject({
      env: "prod",
    });

    yield* destroy();

    const deleted = yield* IAM.getRole({
      RoleName: role.roleName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }).pipe(Effect.provide(AWS.providers())),
);
