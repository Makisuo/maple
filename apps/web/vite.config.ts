import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import tanstackRouter from "@tanstack/router-plugin/vite"
import viteReact from "@vitejs/plugin-react"
import viteTsConfigPaths from "vite-tsconfig-paths"
import tailwindcss from "@tailwindcss/vite"
import alchemy from "alchemy/cloudflare/vite"

const envDir = path.resolve(import.meta.dirname, "../..")

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "")

  if (!process.env.VITE_MAPLE_AUTH_MODE) {
    process.env.VITE_MAPLE_AUTH_MODE = env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
  }

  if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
    process.env.VITE_CLERK_PUBLISHABLE_KEY = env.CLERK_PUBLISHABLE_KEY?.trim() || ""
  }

  const isAlchemyRun = Boolean(process.env.ALCHEMY_ROOT)

  return {
    envDir,
    plugins: [
      devtools(),
      tanstackRouter({ target: "react", autoCodeSplitting: false }),
      viteTsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      tailwindcss(),
      viteReact(),
      ...(isAlchemyRun ? [alchemy({ configPath: "./wrangler.jsonc" })] : []),
    ],
  }
})
