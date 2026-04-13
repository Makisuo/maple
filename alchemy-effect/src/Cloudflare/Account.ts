import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { StageConfig } from "./StageConfig.ts";

export class Account extends Context.Service<Account, string>()(
  "cloudflare/account-id",
) {}

export const fromEnv = () =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
      if (!accountId) {
        return yield* Effect.die("CLOUDFLARE_ACCOUNT_ID is not set");
      }
      return accountId;
    }),
  );

export const fromStageConfig = () =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const stageConfig = yield* Effect.serviceOption(StageConfig).pipe(
        Effect.map(Option.getOrUndefined),
      );
      const account =
        stageConfig?.account ?? (yield* Config.string("CLOUDFLARE_ACCOUNT_ID"));
      if (!account) {
        return yield* Effect.die("CLOUDFLARE_ACCOUNT_ID is not set");
      }
      return account;
    }),
  );
