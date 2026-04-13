import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

export const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset);
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset;
  const url = new URL(asset, import.meta.url);
  return fileURLToPath(url);
};

export const loadParser = Effect.fn("loadParser")(function* (wasmPath: string) {
  const treeWasm = yield* Effect.promise(
    () =>
      // @ts-expect-error
      import("web-tree-sitter/tree-sitter.wasm", {
        with: { type: "wasm" },
      }),
  );
  const treePath = resolveWasm(treeWasm);
  yield* Effect.promise(() =>
    Parser.init({
      locateFile() {
        return treePath;
      },
    }),
  );
  const { default: wasm } = yield* Effect.promise(
    () =>
      import(wasmPath, {
        with: { type: "wasm" },
      }),
  );
  const bashPath = resolveWasm(wasm);
  const bashLanguage = yield* Effect.promise(() => Language.load(bashPath));
  const p = new Parser();
  p.setLanguage(bashLanguage);
  return p;
});
