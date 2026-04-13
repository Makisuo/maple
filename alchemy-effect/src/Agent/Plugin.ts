import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Aspect } from "./Aspect.ts";
import type { ContextPlugin, ContextPluginService } from "./ContextPlugin.ts";

export type Plugins<A extends Aspect> = {
  readonly context: Plugin<ContextPlugin<A>, ContextPluginService<A>>;
};

export type Plugin<Tag, Service> = {
  effect: <Err, Req>(
    eff: Effect.Effect<Service, Err, Req>,
  ) => Layer.Layer<Tag, Err, Req>;
  succeed: (service: Service) => Layer.Layer<Tag>;
};

export type ContextPlugins<C> = C extends Aspect ? ContextPlugin<C> : never;

export const createPluginBuilder = <
  Tag extends Context.Service<string, Service>,
  Service,
>(
  tag: Tag,
) => ({
  effect: <Err, Req>(eff: Effect.Effect<Service, Err, Req>) =>
    Layer.effect(tag, eff),
  succeed: (service: Service) => Layer.succeed(tag, service),
});
