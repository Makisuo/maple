import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev, none } from "eve/channels/auth";

/**
 * Auth for eve's own HTTP routes (session/stream/health/etc.).
 *
 * The Slack webhook route (/eve/v1/slack) is verified independently via the
 * Slack signing secret, so this policy only governs the browser/API surface.
 *
 * - localDev(): opens the routes for `eve dev` and the local REPL.
 * - If ROUTE_AUTH_BASIC_PASSWORD is set, the deployed routes require HTTP Basic.
 *   Otherwise they are public (none()) — fine for a general demo, but set the
 *   password (or swap in jwt/oidc) before exposing anything sensitive.
 */
const basicPassword = process.env.ROUTE_AUTH_BASIC_PASSWORD;

export default eveChannel({
  auth: [
    localDev(),
    basicPassword
      ? httpBasic({
          username: process.env.ROUTE_AUTH_BASIC_USER ?? "admin",
          password: basicPassword,
        })
      : none(),
  ],
});
