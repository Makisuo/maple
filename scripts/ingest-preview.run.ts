/**
 * On-demand ECS deployment of the ingest gateway for ONE pull request
 * (`.github/workflows/deploy-pr-ingest.yml`).
 *
 * This is deliberately its own stack, not the `pr` stage of the main stack:
 * PR previews are disabled (2026-08, cost) and, when they ran, they never
 * carried the AWS half — `stageDeploysIngest` excludes `pr`, and a VPC + ALB
 * per PR is real money for a stack nothing points at. A preview of the
 * gateway is still the only way to test `apps/ingest` on Fargate before it
 * reaches staging, so this deploys exactly `createMapleIngest` for
 * `pr-<n>`, nothing else, and is destroyed by hand (or by re-running the
 * workflow with `action: destroy`).
 *
 * What you get: the ALB hostname in `serviceUrl`, plain HTTP on port 80 —
 * `resolveMapleDomains` gives a PR no ingest domain, so no ACM certificate is
 * requested and alchemy's ECS service falls back to an HTTP listener. Point an
 * OTLP exporter straight at `http://<alb>/v1/traces` with a staging ingest key;
 * the task reads its key store and Tinybird target from the staging secrets
 * the workflow loads.
 *
 * Guarded to `pr-<n>` stages only: the stack name differs from the main
 * stack, so running it as `prd` or `stg` would create a second, unmanaged
 * fleet beside the real one rather than update it.
 */
import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { parseMapleRegion, resolveAwsRegion } from "@maple/infra/aws"
import { formatMapleStage, parseMapleStage, resolveMapleDomains } from "@maple/infra/cloudflare"
import { createMapleIngest } from "../apps/ingest/alchemy.run.ts"

// Same shim as alchemy.run.ts: Infisical defines the account id under the v1
// name, the v2 auth provider (and the shared state store) read the v2 one.
if (!process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID) {
	process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
}

export default Alchemy.Stack(
	"maple-ingest-preview",
	{
		providers: AWS.providers(),
		// The shared account state store, like the main stack, so a preview
		// deployed from one runner can be destroyed from another.
		state: process.env.ALCHEMY_LOCAL_STATE ? Alchemy.localState() : Cloudflare.state(),
	},
	Effect.gen(function* () {
		const stage = parseMapleStage(yield* Alchemy.Stage)
		if (stage.kind !== "pr") {
			throw new Error(
				`ingest-preview only deploys pr-<n> stages, got "${formatMapleStage(stage)}". ` +
					"prd/stg ingest is part of the main stack (alchemy.run.ts, MAPLE_DEPLOY_AWS_INGEST=1).",
			)
		}

		const region = parseMapleRegion(process.env.MAPLE_REGION)
		const expectedAwsRegion = resolveAwsRegion(region)
		const configuredAwsRegion = process.env.AWS_REGION?.trim()
		if (configuredAwsRegion && configuredAwsRegion !== expectedAwsRegion) {
			throw new Error(
				`AWS_REGION="${configuredAwsRegion}" does not match MAPLE_REGION="${region}" (expects "${expectedAwsRegion}").`,
			)
		}

		const ingest = yield* createMapleIngest({
			stage,
			domains: resolveMapleDomains(stage),
			region,
		})

		return {
			stage: formatMapleStage(stage),
			// http://<alb-hostname> — no ingest domain, so no certificate and an
			// HTTP listener on 80.
			ingestServiceUrl: ingest.serviceUrl,
		}
	}),
)
