import { randomBytes } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev } from "eve/channels/auth";

/**
 * Auth for eve's own HTTP routes (session/stream/info).
 *
 * Not used right now, but the default is basically that it's impossible to reach, 
 * so I set it up if we ever need it.
 */
const isDeployed =
  Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
  process.env.NODE_ENV === "production";

let password = process.env.ROUTE_AUTH_BASIC_PASSWORD;
const username = process.env.ROUTE_AUTH_BASIC_USER ?? "admin";

if(!password && isDeployed){
  password = randomBytes(24).toString("base64url");
  console.warn(
    `[route-auth] ROUTE_AUTH_BASIC_PASSWORD is not set in a deployed environment. ` +
      `Refusing to serve the browser/API routes publicly; generated a one-boot HTTP Basic credential instead: ` +
      `user="${username}" password="${password}". ` +
      `Set ROUTE_AUTH_BASIC_PASSWORD as a service variable for a stable credential. ` +
      `(The Slack webhook is unaffected — it is signature-verified independently.)`,
  );
}

export default eveChannel({
  auth: isDeployed ? [httpBasic({ username, password: password! })] : [localDev()],
});
