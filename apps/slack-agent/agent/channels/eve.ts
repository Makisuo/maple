import { randomBytes } from "node:crypto"
import { eveChannel } from "eve/channels/eve"
import { httpBasic, localDev } from "eve/channels/auth"
import { isDeployedEnvironment } from "#lib/env.js"

/**
 * Auth for eve's own HTTP routes (session/stream/info).
 *
 * Not used right now, but the default is basically that it's impossible to reach,
 * so I set it up if we ever need it.
 *
 * Deployed with no `ROUTE_AUTH_BASIC_PASSWORD`, the routes are locked shut: we
 * mint a random secret that is never printed anywhere, so nobody — including
 * whoever reads the deploy logs — can authenticate until a real password is
 * configured. Logging the generated password (the previous behavior) would
 * park a working credential in Railway's log store for the life of the process,
 * where it outlives the boot line and is readable by anyone with log access.
 */
const isDeployed = isDeployedEnvironment()

const configuredPassword = process.env.ROUTE_AUTH_BASIC_PASSWORD
const username = process.env.ROUTE_AUTH_BASIC_USER ?? "admin"

let password = configuredPassword

if (!password && isDeployed) {
	// Unrecoverable by design — see the header comment. Not logged, not derived
	// from anything guessable.
	password = randomBytes(32).toString("base64url")
	console.error(
		`[route-auth] ROUTE_AUTH_BASIC_PASSWORD is not set in a deployed environment. ` +
			`The browser/API routes (session/stream/info) are now UNREACHABLE: they are locked behind a ` +
			`random secret that is generated per boot and deliberately never logged. ` +
			`Set ROUTE_AUTH_BASIC_PASSWORD as a service variable to use them. ` +
			`(The Slack webhook is unaffected — it is signature-verified independently, and ` +
			`/eve/v1/health stays open for Railway's healthcheck.)`,
	)
}

export default eveChannel({
	auth: isDeployed ? [httpBasic({ username, password: password! })] : [localDev()],
})
