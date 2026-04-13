import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import assert from "node:assert";
import * as rolldown from "rolldown";
import { sha256, sha256Object } from "../Util/sha256.ts";

export interface BundleOutput {
  /**
   * The files in the bundle.
   * The first file is the entry.
   */
  readonly files: [BundleFile, ...BundleFile[]];
  /**
   * The SHA-256 hash of all files in the bundle.
   */
  readonly hash: string;
}

export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array<ArrayBufferLike>;
  readonly hash: string;
}

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Build a bundle using rolldown from the given input options and output options.
 * @param inputOptions - The input options for the bundle.
 * @param outputOptions - The output options for the bundle.
 * @returns The bundle output.
 */
export const build = (
  inputOptions: rolldown.InputOptions,
  outputOptions?: rolldown.OutputOptions,
): Effect.Effect<BundleOutput, BundleError> =>
  Effect.tryPromise({
    try: async () => {
      const bundle = await rolldown.rolldown({
        ...inputOptions,
        optimization: inputOptions.optimization ?? {
          inlineConst: {
            mode: "smart",
            pass: 3,
          },
        },
      });
      const result = await bundle.generate(outputOptions);
      await bundle.close();
      return result.output;
    },
    catch: bundleErrorFromUnknown,
  }).pipe(
    Effect.flatMap(Effect.forEach(bundleFileFromOutputChunk)),
    Effect.flatMap(bundleOutputFromFiles),
  );

/**
 * Watch for changes in the bundle and return a stream of bundle output.
 * @param inputOptions - The input options for the bundle.
 * @param outputOptions - The output options for the bundle.
 * @returns A stream of Result instances containing either the bundle output or an error.
 */
export const watch = (
  inputOptions: rolldown.InputOptions,
  outputOptions?: rolldown.OutputOptions,
): Stream.Stream<Result.Result<BundleOutput, BundleError>> =>
  Stream.callback<Result.Result<rolldown.OutputBundle, BundleError>>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = rolldown.watch({
          ...inputOptions,
          plugins: [
            inputOptions.plugins,
            // The watcher event listener does not receive the bundle output, so we grab it using a plugin.
            {
              name: "alchemy:watch-bundle",
              generateBundle(_outputOptions, bundle) {
                Queue.offerUnsafe(queue, Result.succeed(bundle));
              },
            },
          ],
          output: outputOptions,
        });
        watcher.on("event", (event) => {
          if (event.code === "ERROR") {
            Queue.offerUnsafe(
              queue,
              Result.fail(bundleErrorFromUnknown(event.error)),
            );
          } else if (event.code === "BUNDLE_END") {
            // This must be called to avoid resource leaks.
            event.result.close().catch(() => {});
          }
        });
        return watcher;
      }),
      (watcher) => Effect.promise(() => watcher.close()),
    ),
  ).pipe(
    Stream.mapEffect((result) =>
      Effect.gen(function* () {
        if (result._tag === "Failure") {
          return Result.fail(result.failure);
        }
        return yield* bundleOutputFromRolldownOutputBundle(result.success).pipe(
          Effect.map(Result.succeed),
          Effect.catch((error) => Effect.succeed(Result.fail(error))),
        );
      }),
    ),
    Stream.changesWith((left, right) => {
      if (left._tag === "Success" && right._tag === "Success") {
        return left.success.hash === right.success.hash;
      }
      return false;
    }),
  );

const ENTRY_MODULE_ID = "virtual:alchemy-entry";
const ENTRY_MODULE_REGEX = new RegExp(`^${ENTRY_MODULE_ID}$`);

export const virtualEntryPlugin = Effect.gen(function* () {
  const path = yield* Path.Path;
  return (content: (importPath: string) => string) => {
    let importPath: string | undefined;
    return {
      name: "alchemy:virtual-entry",
      options(inputOptions) {
        assert(
          typeof inputOptions.input === "string",
          "input must be a string",
        );
        importPath = `./${path.relative(inputOptions.cwd ?? process.cwd(), inputOptions.input)}`;
        inputOptions.input = ENTRY_MODULE_ID;
      },
      resolveId: {
        filter: { id: ENTRY_MODULE_REGEX },
        handler() {
          return { id: ENTRY_MODULE_ID };
        },
      },
      load: {
        filter: { id: ENTRY_MODULE_REGEX },
        handler() {
          assert(importPath !== undefined, "importPath must be defined");
          return { code: content(importPath), moduleType: "ts" };
        },
      },
    } satisfies rolldown.Plugin;
  };
});

export function bundleOutputFromRolldownOutputBundle(
  bundle: rolldown.OutputBundle,
): Effect.Effect<BundleOutput, BundleError> {
  const files = Object.values(bundle);
  // These are sanity checks - with rolldown, the first file is always an entry chunk.
  if (!files[0] || files[0].type !== "chunk" || !files[0].isEntry) {
    return Effect.fail(
      new BundleError({
        message: "Invalid bundle output",
      }),
    );
  }
  return Effect.forEach(
    files as [
      rolldown.OutputChunk,
      ...(rolldown.OutputChunk | rolldown.OutputAsset)[],
    ],
    bundleFileFromOutputChunk,
  ).pipe(Effect.flatMap(bundleOutputFromFiles));
}

function bundleErrorFromUnknown(error: unknown): BundleError {
  const message = error instanceof Error ? error.message : String(error);
  return new BundleError({
    message,
    cause: error,
  });
}

function bundleOutputFromFiles(
  files: [BundleFile, ...BundleFile[]],
): Effect.Effect<BundleOutput> {
  return Effect.map(
    sha256Object(
      files.map((file) => ({
        path: file.path,
        hash: file.hash,
      })),
    ),
    (hash) => ({ files, hash }),
  );
}

function bundleFileFromOutputChunk(
  chunk: rolldown.OutputChunk | rolldown.OutputAsset,
): Effect.Effect<BundleFile> {
  switch (chunk.type) {
    case "chunk":
      return Effect.map(sha256(chunk.code), (hash) => ({
        path: chunk.fileName,
        content: chunk.code,
        hash,
      }));
    case "asset":
      return Effect.map(sha256(chunk.source), (hash) => ({
        path: chunk.fileName,
        content: chunk.source,
        hash,
      }));
  }
}
