/**
 * Manual bisect harness for the ingest deploy hang (`.github/workflows/aws-probe.yml`).
 *
 * Four prd deploys wedged inside `alchemy deploy` with no output at any log
 * level, no AWS API call in CloudTrail, and no resource created. Every
 * candidate inside the process has been measured and cleared — module import
 * 1.2s, hashDirectory 39ms, the auth lock caps at 120s with an error, a local
 * plan reaches the generator in under a second. What was missing is a way to
 * ask the question in the environment where it actually happens without paying
 * a 45-minute production timeout per attempt.
 *
 * So: the same AWS provider set, on the same runner image, with the same OIDC
 * credentials, one resource class at a time.
 *
 * - `ecr`     — a repository. Does the AWS provider path work AT ALL in CI?
 * - `network` — a VPC. Does a multi-resource, slower graph work?
 * - `image`   — a docker build + ECR push of the real ingest context. This is
 *               the leading suspect: it runs before the first AWS call (which
 *               is why CloudTrail is empty) and alchemy logs nothing while it
 *               works, which is why the deploy looks dead.
 *
 * State is file-based, so this never touches the shared account state store,
 * and the CIDR is 10.99/16 — deliberately outside the 10.20/10.21 range
 * `resolveIngestCidrBlock` hands out, so a leaked probe VPC can never collide
 * with a real regional one.
 */
import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import * as Effect from "effect/Effect"

type ProbeLevel = "ecr" | "network" | "image"

const level = (process.env.PROBE_LEVEL ?? "ecr") as ProbeLevel

export default Alchemy.Stack(
	"aws-probe",
	{ providers: AWS.providers(), state: Alchemy.localState() },
	Effect.gen(function* () {
		const tags = { Service: "maple-aws-probe", Ephemeral: "true" }

		const repository = yield* AWS.ECR.Repository("probe-repo", {
			repositoryName: "maple-aws-probe",
			tags,
		})
		if (level === "ecr") {
			return { level, repositoryUri: repository.repositoryUri }
		}

		const network = yield* AWS.EC2.Network("probe-network", {
			cidrBlock: "10.99.0.0/16",
			availabilityZones: 2,
			nat: "none",
			gatewayEndpoints: ["s3"],
			tags,
		})
		if (level === "network") {
			return { level, vpcId: network.vpcId }
		}

		// The real context and the real Dockerfile — a build+push with no ECS
		// service around it, so a hang here isolates the image step from
		// everything the service does afterwards.
		const image = yield* AWS.ECR.Image("probe-image", {
			repositoryUri: repository.repositoryUri,
			context: "apps/ingest",
			dockerfile: "apps/ingest/Dockerfile.prebuilt",
			platform: "linux/amd64",
		})
		return { level, imageUri: image.imageUri }
	}),
)
