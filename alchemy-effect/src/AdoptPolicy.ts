import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class AdoptPolicy extends Context.Service<AdoptPolicy, boolean>()(
  "AdoptPolicy",
) {}

export const adopt: {
  (
    enabled?: boolean,
  ): <R, Req = never>(
    effect: Effect.Effect<R, never, Req>,
  ) => Effect.Effect<R, never, Req>;
  <Req = never>(
    enabled: Effect.Effect<boolean, never, Req>,
  ): <R, Req2 = never>(
    effect: Effect.Effect<R, never, Req2>,
  ) => Effect.Effect<R, never, Req | Req2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any>) =>
  (eff: Effect.Effect<any, never, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(AdoptPolicy, enabled ?? true)
        : Effect.provideServiceEffect(AdoptPolicy, enabled),
    )) as any;
