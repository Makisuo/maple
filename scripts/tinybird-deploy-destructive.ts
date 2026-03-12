/**
 * Deploy the current Tinybird project to the configured target.
 *
 * Usage: bun scripts/tinybird-deploy-destructive.ts
 */

// @ts-ignore — Tinybird SDK does not expose this entrypoint publicly.
import { loadConfig } from "../node_modules/@tinybirdco/sdk/dist/cli/config.js";
import { syncTinybirdProject } from "@maple/domain/tinybird-project-sync";

async function main() {
  const config = loadConfig(process.cwd());
  const result = await syncTinybirdProject({
    baseUrl: config.baseUrl,
    token: config.token,
  });
  console.log(`Tinybird project synced (${result.result}) at revision ${result.projectRevision}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
