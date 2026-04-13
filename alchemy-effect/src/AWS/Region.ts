import * as Auth from "@distilled.cloud/aws/Auth";
import * as Region from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { StageConfig } from "./StageConfig.ts";

export { Region } from "@distilled.cloud/aws/Region";

export const AWS_REGION = Config.string("AWS_REGION");

export type RegionID = string;

export const of = (region: string) => Layer.succeed(Region.Region, region);

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region.Region, process.env.AWS_REGION ?? region);

export class EnvironmentVariableNotSet extends Data.TaggedError(
  "EnvironmentVariableNotSet",
)<{
  message: string;
  variable: string;
}> {}

const tryGetAWSRegion = () =>
  Config.option(AWS_REGION).pipe(Config.map(Option.getOrUndefined));

export const fromEnv = () =>
  Layer.effect(
    Region.Region,
    Effect.gen(function* () {
      const region = yield* tryGetAWSRegion();
      if (!region) {
        return yield* Effect.fail(
          new EnvironmentVariableNotSet({
            message: "AWS_REGION is not set",
            variable: "AWS_REGION",
          }),
        );
      }
      return region;
    }),
  );

export class AWSStageConfigRegionMissing extends Data.TaggedError(
  "AWSStageConfigMissing",
)<{
  message: string;
  stage: string;
}> {}

export const fromStageConfig = () =>
  Layer.effect(
    Region.Region,
    Effect.gen(function* () {
      const config = yield* StageConfig;
      const auth = yield* Auth.Default;
      if (config.region) {
        return config.region;
      } else if (config.profile) {
        const profile = yield* auth.loadProfile(config.profile);
        if (profile.region) {
          return profile.region;
        }
      }
      const region = yield* tryGetAWSRegion();
      if (region) {
        return region;
      }
      return yield* Effect.die(
        "No AWS region found in stage config, SSO profile, or environment variable",
      );
    }),
  );
