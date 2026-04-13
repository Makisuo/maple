import * as Auth from "@distilled.cloud/aws/Auth";
import type { AwsCredentialIdentity } from "@smithy/types";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AccountID } from "./Account.ts";
import { AWS_REGION, type RegionID } from "./Region.ts";

export const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

export class StageConfig extends Context.Service<
  StageConfig,
  {
    account?: AccountID;
    region?: RegionID;
    profile?: string;
    credentials?: AwsCredentialIdentity;
    endpoint?: string;
  }
>()("AWS::StageConfig") {}

export const DefaultStageConfig = Layer.effect(
  StageConfig,
  Effect.suspend(() => loadDefaultStageConfig()),
).pipe(Layer.orDie);

export const loadDefaultStageConfig = () =>
  Effect.gen(function* () {
    const profileName = yield* AWS_PROFILE;
    const profile = yield* Auth.loadProfile(profileName);
    if (!profile.sso_account_id) {
      return yield* Effect.die(
        `AWS SSO Profile '${profileName}' is missing sso_account_id configuration`,
      );
    }
    return {
      profile: profileName,
      account: profile.sso_account_id,
      region: profile.region ?? (yield* AWS_REGION),
    };
  });
