import { cloudflare } from "@cloudflare/vite-plugin"
import { flue, flueWorkerConfig } from "@flue/vite"
import { defineConfig } from "vite"

/**
 * Flue 2 builds through Vite — the `flue build` / `flue dev` CLI commands are
 * gone. `flue()` MUST come first: it scans `'use agent'` modules, generates the
 * Cloudflare Worker entry (one Durable Object class per agent), and merges the
 * authored `wrangler.jsonc` into the gitignored `.flue-vite.wrangler.jsonc` that
 * `cloudflare()` then consumes.
 *
 * `flueWorkerConfig()` is what hands the generated entry + DO bindings to the
 * Cloudflare plugin; without it the build fails outright.
 *
 * Do NOT hand-author `FLUE_*` Durable Object bindings in `wrangler.jsonc` — the
 * plugin owns them and errors on a conflicting authored binding. Migrations are
 * ours to author (and are append-only once deployed).
 */
export default defineConfig({
	plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
})
