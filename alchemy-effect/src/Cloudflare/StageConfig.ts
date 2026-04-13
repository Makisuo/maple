import * as Context from "effect/Context";

export class StageConfig extends Context.Service<
  StageConfig,
  {
    account?: string;
  }
>()("Cloudflare::StageConfig") {}
