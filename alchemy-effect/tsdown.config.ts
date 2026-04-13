import { defineConfig } from "tsdown";

export default [
  // bundle the CLi into a standalone executable
  defineConfig({
    entry: ["bin/alchemy-effect.ts"],
    format: ["esm"],
    clean: false,
    shims: true,
    outDir: "bin",
    dts: false,
    sourcemap: true,
    outputOptions: {
      inlineDynamicImports: true,
    },
    noExternal: ["execa", "open", "env-paths"],
    tsconfig: "tsconfig.bundle.json",
  }),
  // bundlde the cli entrypoint so that react does not end up in our dependencies
  // problem‼️ this means react is bundled twice in our tar.gz. Should we have bin/alchemy-effect.ts import the cli entrypoint instead?
  defineConfig({
    entry: ["src/Cli/index.ts"],
    format: ["esm"],
    clean: false,
    shims: true,
    outDir: "lib/cli",
    dts: true,
    sourcemap: true,
    // external: ["react-devtools-core"],
    outputOptions: {
      inlineDynamicImports: true,
      banner: "#!/usr/bin/env node",
    },
  }),
];
