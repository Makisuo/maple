import * as Effect from "effect/Effect";
import { Command, type CommandProps } from "../../Build/Command.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import { Worker, type WorkerProps } from "../Workers/Worker.ts";

export interface StaticSiteProps
  extends Omit<WorkerProps, "assets">, Omit<CommandProps, "env"> {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assetsConfig?: AssetsConfig;
  dev?: {
    command: string;
  };
}

export const StaticSite = (id: string, props: InputProps<StaticSiteProps>) =>
  Effect.gen(function* () {
    // TODO(sam): local dev/hmr support?
    const build = yield* Command("Build", props);

    const worker = yield* Worker("Worker", {
      ...props,
      assets: {
        path: build.outdir,
        hash: build.hash,
        config: props.assetsConfig,
      },
    });

    return worker;
  }).pipe(Namespace.push(id));
