import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export type cwd = typeof cwd;

/**
 * Placeholder for referencing the current working directory in module-scoped code.
 *
 * Will be replaced lazily with the actual current working directory (as provided by Effect context).
 */
export const cwd = { type: "cwd" } as const;

export const isCwd = (x: any): x is cwd => x?.type === "cwd";

export class DotAlchemy extends Context.Service<DotAlchemy, string>()(
  ".alchemy",
) {}

export const dotAlchemy = Layer.effect(
  DotAlchemy,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(process.cwd(), ".alchemy");
    yield* fs.makeDirectory(dir, { recursive: true });
    return dir;
  }),
);
