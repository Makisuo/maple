import path from "node:path";
import type { PluginOption } from "vite-plus";
import { defineConfig, loadEnv } from "vite-plus";
import { devtools } from "@tanstack/devtools-vite";
import tanstackRouter from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/vite";

const envDir = path.resolve(import.meta.dirname, "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");

  if (!process.env.VITE_MAPLE_AUTH_MODE) {
    process.env.VITE_MAPLE_AUTH_MODE = env.MAPLE_AUTH_MODE?.trim() || "self_hosted";
  }

  if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
    process.env.VITE_CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY?.trim() || "";
  }

  const plugins: PluginOption[] = [
    devtools(),
    tanstackRouter({ target: "react", autoCodeSplitting: false }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    viteReact(),
  ];

  if (process.env.ALCHEMY_ROOT) {
    plugins.push(alchemy({ configPath: "./wrangler.jsonc" }));
  }

  return {
    envDir,
    plugins,
  };
});
