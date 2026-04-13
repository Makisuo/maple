import * as Auth from "@distilled.cloud/aws/Auth";
import {
  Credentials,
  fromAwsCredentialIdentity,
} from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Profile } from "./Profile.ts";

import { StageConfig } from "./StageConfig.ts";

export { Credentials } from "@distilled.cloud/aws/Credentials";

/**
 * Create a lazy credentials layer from stage config.
 * Credentials are resolved on first access, not during layer construction.
 */
export const fromStageConfig = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const config = yield* StageConfig;
      const auth = yield* Auth.Default;
      if (config.profile) {
        // Return the lazy Effect - it will be resolved when credentials are actually needed
        return auth.loadProfileCredentials(config.profile);
      } else if (config.credentials) {
        // Static credentials - wrap in Effect.succeed
        return Effect.succeed(fromAwsCredentialIdentity(config.credentials));
      }
      return yield* Effect.die("No AWS credentials found in stage config");
    }),
  );

/**
 * Create a lazy SSO credentials layer.
 * Credentials are resolved on first access, not during layer construction.
 */
export const fromSSO = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const auth = yield* Auth.Auth;
      const profileName = Option.getOrElse(
        yield* Effect.serviceOption(Profile),
        () => "default",
      );
      // Return the lazy Effect - it will be resolved when credentials are actually needed
      return auth.loadProfileCredentials(profileName);
    }),
  );
