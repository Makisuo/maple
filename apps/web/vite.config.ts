import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import tanstackRouter from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
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

  // Vite's loadEnv gives `.env*` files higher precedence than `process.env` for
  // VITE_* keys. During a deploy build we inject VITE_* via process.env, so
  // override the Vite default with `define` to make process.env win.
  const overrideKeys = [
    "VITE_API_BASE_URL",
    "VITE_INGEST_URL",
    "VITE_CHAT_AGENT_URL",
    "VITE_MAPLE_AUTH_MODE",
    "VITE_CLERK_PUBLISHABLE_KEY",
  ] as const;
  const define: Record<string, string> = {};
  for (const key of overrideKeys) {
    const value = process.env[key]?.trim();
    if (value) {
      define[`import.meta.env.${key}`] = JSON.stringify(value);
    }
  }

  return {
    envDir,
    resolve: {
      tsconfigPaths: true,
    },
    define,
    plugins: [
      devtools(),
      tanstackRouter({ target: "react", autoCodeSplitting: false }),
      tailwindcss(),
      viteReact(),
      ...(process.env.ALCHEMY_ROOT ? [alchemy({ configPath: "./wrangler.jsonc" })] : []),
    ],
  };
});
