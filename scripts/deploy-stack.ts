type Action = "deploy" | "destroy"
type Stage = "prd" | "stg" | "pr"

const [actionArg, stageArg] = Bun.argv.slice(2)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseAction(value: string | undefined): Action {
  if (value === "deploy" || value === "destroy") {
    return value
  }
  return fail("Usage: bun scripts/deploy-stack.ts <deploy|destroy> <prd|stg|pr>")
}

function parseStage(value: string | undefined): Stage {
  if (value === "prd" || value === "stg" || value === "pr") {
    return value
  }
  return fail("Usage: bun scripts/deploy-stack.ts <deploy|destroy> <prd|stg|pr>")
}

function resolveStage(stage: Stage): string {
  if (stage !== "pr") {
    return stage
  }

  const raw = process.env.PR_NUMBER?.trim()
  if (!raw) {
    return fail("PR_NUMBER is required for pr deploy/destroy")
  }

  const prNumber = Number(raw)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return fail(`PR_NUMBER must be a positive integer. Received: ${raw}`)
  }

  return `pr-${prNumber}`
}

const action = parseAction(actionArg)
const stage = parseStage(stageArg)
const stageValue = resolveStage(stage)
const turboTask = action === "deploy" ? "deploy:stack" : "destroy:stack"

if (!process.env.RAILWAY_API_TOKEN?.trim()) {
  fail("RAILWAY_API_TOKEN is required for deploy/destroy (Railway + Cloudflare).")
}

const proc = Bun.spawn(
  ["turbo", turboTask, "--", "--stage", stageValue],
  {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  },
)

const exitCode = await proc.exited
process.exit(exitCode)
export { }
