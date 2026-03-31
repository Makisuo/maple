import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    "index.server": "./src/index.server.ts",
    "index.client": "./src/index.client.ts",
    "index.types": "./src/index.types.ts",
    "server/index": "./src/server/index.ts",
    "client/index": "./src/client/index.ts",
  },
  format: "esm",
  dts: true,
  outDir: "dist",
  deps: {
    neverBundle: ["effect"],
  },
})
