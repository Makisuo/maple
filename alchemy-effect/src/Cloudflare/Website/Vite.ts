import type { InputProps } from "../../Input.ts";
import type { MemoOptions } from "../../Build/Memo.ts";
import { Worker, type WorkerProps } from "../Workers/Worker.ts";

export interface ViteProps extends Omit<WorkerProps, "vite" | "main"> {
  /**
   * Root directory passed to Vite's `root` option.
   * Defaults to the current working directory (`process.cwd()`).
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether a rebuild is needed.
   * By default every non-gitignored file in `cwd` is hashed, plus the nearest
   * lockfile. Provide explicit globs to narrow the scope.
   *
   * @see {@link MemoOptions}
   */
  memo?: MemoOptions;
}

/**
 * A Cloudflare Worker deployed from a Vite project.
 *
 * `Vite` uses the Cloudflare Vite plugin to build both the server bundle and
 * client assets in a single `vite build` invocation — no manual `main`
 * entrypoint, build command, output directory, or Wrangler configuration
 * required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * @section Deploying a Static Site
 * @example Basic Static Site
 * ```typescript
 * const site = yield* Cloudflare.Vite("Website");
 * ```
 *
 * @section Deploying a TanStack Start App
 * @example TanStack Start with SSR
 * ```typescript
 * const app = yield* Cloudflare.Vite("TanStackStart", {
 *   compatibility: {
 *     flags: ["nodejs_compat"],
 *   },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * @example Narrow the Memo Scope
 * ```typescript
 * const site = yield* Cloudflare.Vite("Docs", {
 *   memo: {
 *     include: ["src/**", "content/**", "package.json"],
 *   },
 * });
 * ```
 */
export const Vite = (id: string, props: InputProps<ViteProps> = {}) =>
  Worker(id, {
    ...props,
    main: undefined!,
    vite: {
      rootDir: props.rootDir,
      memo: props.memo,
    },
  });
