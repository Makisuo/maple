import { randomBytes } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev, none } from "eve/channels/auth";

/**
 * Auth for eve's own HTTP routes (session/stream/info).
 *
 * The Slack webhook route (/eve/v1/slack) is verified independently via the
 * Slack signing secret, and /eve/v1/health is a separate unauthenticated nitro
 * route (verified in eve@0.25.3 internal/nitro/routes/health.js — Railway's
 * healthcheck keeps working under fail-closed auth). This policy only governs
 * the browser/API surface.
 *
 * - localDev(): opens the routes for `eve dev` and the local REPL.
 * - Deployed (RAILWAY_ENVIRONMENT_NAME set, or NODE_ENV=production): the routes
 *   ALWAYS require HTTP Basic — fail closed. If ROUTE_AUTH_BASIC_PASSWORD is
 *   unset we generate a random per-boot password and log it once so the service
 *   still comes up (the Slack webhook keeps working regardless), but the
 *   browser/API surface is never public. Set ROUTE_AUTH_BASIC_PASSWORD for a
 *   stable credential (or swap in jwt/oidc).
 * - Local non-loopback without a password: none() keeps the old open-demo
 *   behavior for local-only setups.
 *
 * Note on timing: this module is evaluated by `eve build` too, but in the
 * Docker build neither RAILWAY_ENVIRONMENT_NAME nor NODE_ENV=production is set
 * yet (NODE_ENV is exported after the build step), so generation happens at
 * runtime boot, once per process.
 */
const isDeployed =
  Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
  process.env.NODE_ENV === "production";

const configuredPassword = process.env.ROUTE_AUTH_BASIC_PASSWORD;
const basicUser = process.env.ROUTE_AUTH_BASIC_USER ?? "admin";

let basicPassword = configuredPassword;
if (!basicPassword && isDeployed) {
  basicPassword = randomBytes(24).toString("base64url");
  console.warn(
    `[route-auth] ROUTE_AUTH_BASIC_PASSWORD is not set in a deployed environment. ` +
      `Refusing to serve the browser/API routes publicly; generated a one-boot HTTP Basic credential instead: ` +
      `user="${basicUser}" password="${basicPassword}". ` +
      `Set ROUTE_AUTH_BASIC_PASSWORD as a service variable for a stable credential. ` +
      `(The Slack webhook is unaffected — it is signature-verified independently.)`,
  );
}

export default eveChannel({
  auth: [
    localDev(),
    basicPassword
      ? httpBasic({ username: basicUser, password: basicPassword })
      : // Local dev only (isDeployed is false here): keep the open-demo
        // behavior. Deployed environments never reach this branch.
        none(),
  ],
});
