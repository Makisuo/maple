import * as Context from "effect/Context";
import type { Aspect } from "./Aspect.ts";

export type ContextPlugin<A extends Aspect> = Context.Service<
  `ContextPlugin<${A["type"]}>`,
  ContextPluginService<A>
>;

export interface ContextPluginService<A extends Aspect> {
  context: (a: A) => string;
}

export const ContextPlugin = <A extends Aspect>(
  type: A["type"],
): ContextPlugin<A> =>
  Context.Service<`ContextPlugin<${A["type"]}>`, ContextPluginService<A>>(
    `ContextPlugin<${type}>`,
  );
