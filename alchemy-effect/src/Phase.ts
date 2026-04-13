import * as Config from "effect/Config";

export const ALCHEMY_PHASE = Config.string("ALCHEMY_PHASE").pipe(
  Config.withDefault("plan"),
);
