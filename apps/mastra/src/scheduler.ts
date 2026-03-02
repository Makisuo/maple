import { mastra } from "./mastra/index"
import { getConfig } from "./mastra/lib/config"
import { getOrgConfigs, ensureTable } from "./mastra/lib/state"

async function runCycle() {
  try {
    const orgConfigs = await getOrgConfigs()

    if (orgConfigs.length === 0) {
      console.log("[scheduler] No active GitHub integrations, skipping cycle")
      return
    }

    console.log(`[scheduler] Processing ${orgConfigs.length} active integration(s)`)

    const workflow = mastra.getWorkflow("anomalyDetectionWorkflow")

    for (const org of orgConfigs) {
      try {
        console.log(`[scheduler] Running detection for org ${org.orgId}`)
        const run = await workflow.createRun()
        const result = await run.start({ inputData: { orgId: org.orgId } })

        if (result.status === "success") {
          const output = result.result as { created: number }
          console.log(
            `[scheduler] Org ${org.orgId}: ${output.created} issue(s) created`,
          )
        } else {
          console.error(`[scheduler] Workflow failed for org ${org.orgId}:`, result)
        }
      } catch (err) {
        console.error(`[scheduler] Error processing org ${org.orgId}:`, err)
      }
    }

    console.log("[scheduler] Cycle complete")
  } catch (err) {
    console.error("[scheduler] Cycle failed:", err)
  }
}

async function main() {
  const config = getConfig()
  const intervalMs = config.AGENT_INTERVAL_SECONDS * 1000

  console.log(
    `[scheduler] Maple Agent starting (interval: ${config.AGENT_INTERVAL_SECONDS}s)`,
  )

  await ensureTable()

  // Run immediately
  await runCycle()

  // Then repeat on interval
  setInterval(runCycle, intervalMs)
}

main().catch((err) => {
  console.error("[scheduler] Fatal error:", err)
  process.exit(1)
})
