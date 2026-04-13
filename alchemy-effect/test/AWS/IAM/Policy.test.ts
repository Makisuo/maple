import * as AWS from "@/AWS";
import { Policy } from "@/AWS/IAM";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

test(
  "create, update, and delete managed policy",
  Effect.gen(function* () {
    yield* destroy();

    const policy = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Policy("IamPolicy", {
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: ["*"],
              },
            ],
          },
          tags: {
            env: "test",
          },
        });
      }),
    );

    const created = yield* IAM.getPolicy({
      PolicyArn: policy.policyArn,
    });
    expect(created.Policy?.PolicyName).toBe(policy.policyName);

    yield* test.deploy(
      Effect.gen(function* () {
        return yield* Policy("IamPolicy", {
          policyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: ["*"],
              },
            ],
          },
          tags: {
            env: "prod",
          },
        });
      }),
    );

    const updatedTags = yield* IAM.listPolicyTags({
      PolicyArn: policy.policyArn,
    });
    expect(
      Object.fromEntries(
        (updatedTags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
      ),
    ).toMatchObject({
      env: "prod",
    });

    yield* destroy();

    const deleted = yield* IAM.getPolicy({
      PolicyArn: policy.policyArn,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }).pipe(Effect.provide(AWS.providers())),
);
