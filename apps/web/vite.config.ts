import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import tanstackRouter from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const envDir = path.resolve(import.meta.dirname, "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");

  if (!process.env.VITE_MAPLE_AUTH_MODE) {
    process.env.VITE_MAPLE_AUTH_MODE = env.MAPLE_AUTH_MODE?.trim() || "self_hosted";
  }

  if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
    process.env.VITE_CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY?.trim() || "";
  }

  // alchemy v2's Cloudflare.Vite resource wires the Cloudflare vite plugin at
  // deploy time via @distilled.cloud/cloudflare-vite-plugin — the project
  // vite.config.ts no longer needs to add it explicitly.
  return {
    envDir,
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      devtools(),
      tanstackRouter({ target: "react", autoCodeSplitting: false }),
      tailwindcss(),
      viteReact(),
    ],
  };
});
