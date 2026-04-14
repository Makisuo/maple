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

export type StaticSite = ReturnType<typeof StaticSite>;

/**
 * A Cloudflare Worker that serves static assets built by a shell command.
 *
 * `StaticSite` runs a build command (e.g. `npm run build`), content-hashes
 * the output directory, and deploys the result as a Cloudflare Worker with
 * static assets. Use this when your site has its own build step that
 * produces a directory of files — Hugo, Zola, Eleventy, or any custom
 * pipeline.
 *
 * For Vite-based projects, prefer `Cloudflare.Vite` which handles
 * building automatically.
 *
 * @resource
 *
 * @section Basic Usage
 * Point `command` at your build script and `outdir` at where it writes
 * output. Alchemy runs the command, hashes the output, and deploys it.
 *
 * @example Deploying a Hugo site
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Blog", {
 *   command: "hugo --minify",
 *   outdir: "public",
 * });
 * ```
 *
 * @section Asset Configuration
 * Use `assetsConfig` to control how Cloudflare handles routing for
 * your static files — HTML handling, not-found behavior, etc.
 *
 * @example SPA-style routing
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("App", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   assetsConfig: {
 *     htmlHandling: "auto-trailing-slash",
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, all non-gitignored files are hashed to decide whether
 * the build should re-run. Use `memo` to narrow the scope.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.StaticSite("Docs", {
 *   command: "npm run build",
 *   outdir: "dist",
 *   memo: {
 *     include: ["content/**", "templates/**", "config.toml"],
 *   },
 * });
 * ```
 */
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
