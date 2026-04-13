import * as Auth from "@distilled.cloud/aws/Auth";
import * as STS from "@distilled.cloud/aws/sts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { StageConfig } from "./StageConfig.ts";

export class FailedToGetAccount extends Data.TaggedError(
  "AWS::Account::FailedToGetAccount",
)<{
  message: string;
  cause: Error;
}> {}

export type AccountID = string;

export class Account extends Context.Service<Account, AccountID>()(
  "AWS::AccountID",
) {}

export class AWSStageConfigAccountMissing extends Data.TaggedError(
  "AWSStageConfigAccountMissing",
)<{
  message: string;
  stage: string;
}> {}

export const fromStageConfig = () =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const config = yield* StageConfig;
      if (config.account) {
        return config.account;
      }
      const profileName = config.profile;
      if (profileName) {
        const profile = yield* Auth.loadProfile(profileName);
        if (profile.sso_account_id) {
          return profile.sso_account_id;
        }
      }
      const identity = yield* STS.getCallerIdentity({}).pipe(
        Effect.catch((err) =>
          Effect.fail(
            new FailedToGetAccount({
              message: "Failed to look up account ID",
              cause: err,
            }),
          ),
        ),
      );
      return identity.Account!;
    }),
  );
