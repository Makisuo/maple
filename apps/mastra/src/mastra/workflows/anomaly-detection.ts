import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"
import { getConfig } from "../lib/config"
import {
  formatForTinybird,
  fetchErrorsSummary,
  fetchErrorsByType,
  fetchServiceOverview,
  fetchServiceApdex,
  fetchErrorTraces,
  searchLogs,
} from "../lib/maple-client"
import { filterNewAnomalies, recordAnomaly, getOrgConfigs, ensureTable } from "../lib/state"
import { getInstallationToken, createGitHubIssue } from "../lib/github"
import type { DetectedAnomaly, EnrichedAnomaly, RepoInfo, ServiceRepoMapping } from "../lib/types"

// --- Detection Logic (deterministic, same as existing agent) ---

function detectErrorRateSpike(
  orgId: string,
  currentStart: Date,
  currentEnd: Date,
  baselineStart: Date,
  baselineEnd: Date,
): Promise<DetectedAnomaly[]> {
  const config = getConfig()
  return (async () => {
    const [current, baseline] = await Promise.all([
      fetchErrorsSummary(orgId, formatForTinybird(currentStart), formatForTinybird(currentEnd)),
      fetchErrorsSummary(orgId, formatForTinybird(baselineStart), formatForTinybird(baselineEnd)),
    ])

    if (!current) return []

    const currentRate = Number(current.errorRate)
    const baselineRate = baseline ? Number(baseline.errorRate) : 0
    const multiplier = config.AGENT_ERROR_RATE_SPIKE_MULTIPLIER
    const absoluteThreshold = config.AGENT_ERROR_RATE_ABSOLUTE_THRESHOLD

    const isSpike =
      (baselineRate > 0 && currentRate > baselineRate * multiplier) ||
      (baselineRate === 0 && currentRate > absoluteThreshold)

    if (!isSpike) return []

    const severity = currentRate > absoluteThreshold * 2 ? "critical" : "warning"

    return [
      {
        kind: "error_rate_spike" as const,
        severity: severity as "critical" | "warning",
        fingerprint: `error_rate_spike:${orgId}`,
        title: `Error rate spike: ${currentRate.toFixed(1)}% (baseline: ${baselineRate.toFixed(1)}%)`,
        description: `Error rate increased from ${baselineRate.toFixed(1)}% to ${currentRate.toFixed(1)}%. Total errors: ${current.totalErrors}, affected services: ${current.affectedServicesCount}.`,
        affectedServices: [],
        detectedAt: currentEnd.toISOString(),
        currentValue: currentRate,
        baselineValue: baselineRate,
        thresholdValue: baselineRate > 0 ? baselineRate * multiplier : absoluteThreshold,
      },
    ]
  })()
}

function detectNewErrorTypes(
  orgId: string,
  currentStart: Date,
  currentEnd: Date,
  baselineStart: Date,
  baselineEnd: Date,
): Promise<DetectedAnomaly[]> {
  const config = getConfig()
  return (async () => {
    const [currentData, baselineData] = await Promise.all([
      fetchErrorsByType(orgId, formatForTinybird(currentStart), formatForTinybird(currentEnd)),
      fetchErrorsByType(orgId, formatForTinybird(baselineStart), formatForTinybird(baselineEnd)),
    ])

    const baselineTypes = new Set(baselineData.map((e) => e.errorType))
    const anomalies: DetectedAnomaly[] = []

    for (const error of currentData) {
      if (!baselineTypes.has(error.errorType) && Number(error.count) >= 3) {
        anomalies.push({
          kind: "new_error_type",
          severity: "warning",
          fingerprint: `new_error_type:${orgId}:${error.errorType}`,
          title: `New error type: ${error.errorType}`,
          description: `A new error type "${error.errorType}" appeared ${error.count} times in the last ${config.AGENT_DETECTION_WINDOW_MINUTES} minutes. Affected services: ${error.affectedServices.join(", ")}.`,
          affectedServices: [...error.affectedServices],
          detectedAt: currentEnd.toISOString(),
          currentValue: Number(error.count),
          thresholdValue: 0,
        })
      }
    }

    return anomalies
  })()
}

function detectLatencyDegradation(
  orgId: string,
  currentStart: Date,
  currentEnd: Date,
  baselineStart: Date,
  baselineEnd: Date,
): Promise<DetectedAnomaly[]> {
  const config = getConfig()
  return (async () => {
    const [currentData, baselineData] = await Promise.all([
      fetchServiceOverview(orgId, formatForTinybird(currentStart), formatForTinybird(currentEnd)),
      fetchServiceOverview(orgId, formatForTinybird(baselineStart), formatForTinybird(baselineEnd)),
    ])

    const baselineByService = new Map(baselineData.map((s) => [s.serviceName, s]))
    const anomalies: DetectedAnomaly[] = []
    const multiplier = config.AGENT_LATENCY_SPIKE_MULTIPLIER

    for (const service of currentData) {
      const baseline = baselineByService.get(service.serviceName)
      if (!baseline) continue

      const currentP99 = Number(service.p99LatencyMs)
      const baselineP99 = Number(baseline.p99LatencyMs)

      if (baselineP99 > 0 && currentP99 > baselineP99 * multiplier) {
        anomalies.push({
          kind: "latency_degradation",
          severity: currentP99 > baselineP99 * multiplier * 2 ? "critical" : "warning",
          fingerprint: `latency_degradation:${orgId}:${service.serviceName}`,
          title: `Latency degradation: ${service.serviceName} P99 ${currentP99.toFixed(0)}ms (baseline: ${baselineP99.toFixed(0)}ms)`,
          description: `P99 latency for ${service.serviceName} increased from ${baselineP99.toFixed(0)}ms to ${currentP99.toFixed(0)}ms (${(currentP99 / baselineP99).toFixed(1)}x increase).`,
          serviceName: service.serviceName,
          affectedServices: [service.serviceName],
          detectedAt: currentEnd.toISOString(),
          currentValue: currentP99,
          baselineValue: baselineP99,
          thresholdValue: baselineP99 * multiplier,
        })
      }
    }

    return anomalies
  })()
}

function detectApdexDrop(
  orgId: string,
  currentStart: Date,
  currentEnd: Date,
): Promise<DetectedAnomaly[]> {
  const config = getConfig()
  return (async () => {
    const services = await fetchServiceOverview(
      orgId,
      formatForTinybird(currentStart),
      formatForTinybird(currentEnd),
    )

    const anomalies: DetectedAnomaly[] = []
    const threshold = config.AGENT_APDEX_THRESHOLD

    for (const service of services) {
      let apdexData: Array<{ apdexScore: number; totalCount: number }>
      try {
        apdexData = await fetchServiceApdex(
          orgId,
          service.serviceName,
          formatForTinybird(currentStart),
          formatForTinybird(currentEnd),
          config.AGENT_DETECTION_WINDOW_MINUTES * 60,
        )
      } catch {
        continue
      }

      if (apdexData.length === 0) continue

      const avgApdex =
        apdexData.reduce((sum, b) => sum + Number(b.apdexScore), 0) / apdexData.length
      const totalCount = apdexData.reduce((sum, b) => sum + Number(b.totalCount), 0)

      if (avgApdex < threshold && totalCount > 10) {
        anomalies.push({
          kind: "apdex_drop",
          severity: avgApdex < threshold * 0.5 ? "critical" : "warning",
          fingerprint: `apdex_drop:${orgId}:${service.serviceName}`,
          title: `Low Apdex: ${service.serviceName} score ${avgApdex.toFixed(3)}`,
          description: `Apdex score for ${service.serviceName} dropped to ${avgApdex.toFixed(3)} (threshold: ${threshold}). Based on ${totalCount} requests in the detection window.`,
          serviceName: service.serviceName,
          affectedServices: [service.serviceName],
          detectedAt: currentEnd.toISOString(),
          currentValue: avgApdex,
          thresholdValue: threshold,
        })
      }
    }

    return anomalies
  })()
}

// --- Workflow Steps ---

const detect = createStep({
  id: "detect",
  description: "Run all anomaly detection strategies against Tinybird data",
  inputSchema: z.object({
    orgId: z.string(),
  }),
  outputSchema: z.object({
    orgId: z.string(),
    anomalies: z.array(z.any()),
  }),
  execute: async ({ inputData }) => {
    const config = getConfig()
    const now = new Date()
    const windowMs = config.AGENT_DETECTION_WINDOW_MINUTES * 60 * 1000
    const currentStart = new Date(now.getTime() - windowMs)
    const baselineEnd = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const baselineStart = new Date(baselineEnd.getTime() - windowMs)

    const [errorRateSpikes, newErrorTypes, latencyDegradation, apdexDrops] = await Promise.all([
      detectErrorRateSpike(inputData.orgId, currentStart, now, baselineStart, baselineEnd),
      detectNewErrorTypes(inputData.orgId, currentStart, now, baselineStart, baselineEnd),
      detectLatencyDegradation(inputData.orgId, currentStart, now, baselineStart, baselineEnd),
      detectApdexDrop(inputData.orgId, currentStart, now),
    ])

    const anomalies = [
      ...errorRateSpikes,
      ...newErrorTypes,
      ...latencyDegradation,
      ...apdexDrops,
    ]

    console.log(
      `[detect] Found ${anomalies.length} anomaly/anomalies for org ${inputData.orgId}`,
    )

    return { orgId: inputData.orgId, anomalies }
  },
})

const deduplicate = createStep({
  id: "deduplicate",
  description: "Filter out anomalies that are still within their cooldown period",
  inputSchema: z.object({
    orgId: z.string(),
    anomalies: z.array(z.any()),
  }),
  outputSchema: z.object({
    orgId: z.string(),
    anomalies: z.array(z.any()),
  }),
  execute: async ({ inputData }) => {
    await ensureTable()
    const newAnomalies = await filterNewAnomalies(
      inputData.orgId,
      inputData.anomalies as DetectedAnomaly[],
    )

    console.log(
      `[deduplicate] ${newAnomalies.length} new of ${inputData.anomalies.length} total for org ${inputData.orgId}`,
    )

    return { orgId: inputData.orgId, anomalies: newAnomalies }
  },
})

const enrich = createStep({
  id: "enrich",
  description: "Fetch sample traces and correlated logs for each anomaly",
  inputSchema: z.object({
    orgId: z.string(),
    anomalies: z.array(z.any()),
  }),
  outputSchema: z.object({
    orgId: z.string(),
    enrichedAnomalies: z.array(z.any()),
  }),
  execute: async ({ inputData }) => {
    const config = getConfig()
    const anomalies = inputData.anomalies as DetectedAnomaly[]
    const enriched: EnrichedAnomaly[] = []

    const now = new Date()
    const windowMs = config.AGENT_DETECTION_WINDOW_MINUTES * 60 * 1000
    const startTime = formatForTinybird(new Date(now.getTime() - windowMs))
    const endTime = formatForTinybird(now)

    for (const anomaly of anomalies) {
      let sampleTraces: EnrichedAnomaly["sampleTraces"] = []
      let correlatedLogs: EnrichedAnomaly["correlatedLogs"] = []

      try {
        // Fetch sample traces based on anomaly kind
        if (anomaly.kind === "new_error_type") {
          const traces = await fetchErrorTraces(
            inputData.orgId,
            anomaly.title.replace("New error type: ", ""),
            startTime,
            endTime,
            3,
          )
          sampleTraces = traces.map((t) => ({
            traceId: String(t.traceId),
            rootSpanName: String(t.rootSpanName),
            durationMs: Number(t.durationMs),
            serviceName: String(t.serviceName),
            statusCode: String(t.statusCode),
          }))
        } else if (anomaly.kind === "error_rate_spike") {
          const traces = await fetchErrorTraces(inputData.orgId, "", startTime, endTime, 3)
          sampleTraces = traces.map((t) => ({
            traceId: String(t.traceId),
            rootSpanName: String(t.rootSpanName),
            durationMs: Number(t.durationMs),
            serviceName: String(t.serviceName),
            statusCode: String(t.statusCode),
          }))
        }

        // Fetch correlated logs for the first sample trace
        if (sampleTraces.length > 0) {
          const logs = await searchLogs(inputData.orgId, {
            traceId: sampleTraces[0]!.traceId,
            limit: 10,
          })
          correlatedLogs = logs.map((l) => ({
            timestamp: String(l.timestamp),
            severity: String(l.severity),
            body: String(l.body),
            serviceName: String(l.serviceName),
          }))
        } else if (anomaly.serviceName) {
          // If no traces, try to get logs for the affected service
          const logs = await searchLogs(inputData.orgId, {
            serviceName: anomaly.serviceName,
            startTime,
            endTime,
            limit: 10,
          })
          correlatedLogs = logs.map((l) => ({
            timestamp: String(l.timestamp),
            severity: String(l.severity),
            body: String(l.body),
            serviceName: String(l.serviceName),
          }))
        }
      } catch (err) {
        console.warn(`[enrich] Failed to enrich anomaly "${anomaly.title}":`, err)
      }

      enriched.push({
        ...anomaly,
        sampleTraceIds: sampleTraces.map((t) => t.traceId),
        sampleTraces,
        correlatedLogs,
      })
    }

    console.log(`[enrich] Enriched ${enriched.length} anomalies for org ${inputData.orgId}`)

    return { orgId: inputData.orgId, enrichedAnomalies: enriched }
  },
})

const createIssues = createStep({
  id: "create-issues",
  description: "Use the LLM agent to write issue bodies, then create GitHub issues",
  inputSchema: z.object({
    orgId: z.string(),
    enrichedAnomalies: z.array(z.any()),
  }),
  outputSchema: z.object({
    created: z.number(),
    results: z.array(
      z.object({
        title: z.string(),
        issueUrl: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
  execute: async ({ inputData, mastra }) => {
    const config = getConfig()
    const anomalies = inputData.enrichedAnomalies as EnrichedAnomaly[]

    if (anomalies.length === 0) {
      return { created: 0, results: [] }
    }

    // Load org config from DB
    const orgConfigs = await getOrgConfigs()
    const orgConfig = orgConfigs.find((c) => c.orgId === inputData.orgId)

    if (!orgConfig) {
      console.warn(`[createIssues] No GitHub integration for org ${inputData.orgId}`)
      // Record anomalies without issues
      for (const anomaly of anomalies) {
        await recordAnomaly(inputData.orgId, anomaly, null, null, null)
      }
      return {
        created: 0,
        results: anomalies.map((a) => ({
          title: a.title,
          issueUrl: null,
          error: "No GitHub integration configured",
        })),
      }
    }

    // Parse repo config
    let repos: RepoInfo[] = []
    try {
      repos = JSON.parse(orgConfig.selectedRepos) as RepoInfo[]
    } catch {
      console.warn(`[createIssues] Failed to parse selected repos for org ${inputData.orgId}`)
    }

    let defaultRepo: RepoInfo | null = null
    try {
      if (orgConfig.defaultRepo) {
        defaultRepo = JSON.parse(orgConfig.defaultRepo) as RepoInfo
      }
    } catch {
      /* empty */
    }

    let mappings: ServiceRepoMapping[] = []
    try {
      mappings = JSON.parse(orgConfig.serviceRepoMappings) as ServiceRepoMapping[]
    } catch {
      /* empty */
    }

    const serviceToRepo = new Map<string, { owner: string; name: string; fullName: string }>()
    for (const m of mappings) {
      const [owner, name] = m.repoFullName.split("/")
      serviceToRepo.set(m.serviceName, { owner: owner!, name: name!, fullName: m.repoFullName })
    }

    function resolveTargetRepo(anomaly: DetectedAnomaly) {
      if (anomaly.serviceName) {
        const mapped = serviceToRepo.get(anomaly.serviceName)
        if (mapped) return mapped
      }
      for (const svc of anomaly.affectedServices) {
        const mapped = serviceToRepo.get(svc)
        if (mapped) return mapped
      }
      if (defaultRepo) return { owner: defaultRepo.owner, name: defaultRepo.name, fullName: defaultRepo.fullName }
      if (repos[0]) return { owner: repos[0].owner, name: repos[0].name, fullName: repos[0].fullName }
      return undefined
    }

    // Get GitHub installation token
    let token: string
    try {
      token = await getInstallationToken(orgConfig.installationId)
    } catch (err) {
      console.error(`[createIssues] Failed to get installation token:`, err)
      for (const anomaly of anomalies) {
        await recordAnomaly(inputData.orgId, anomaly, null, null, null)
      }
      return {
        created: 0,
        results: anomalies.map((a) => ({
          title: a.title,
          issueUrl: null,
          error: `Failed to get GitHub token: ${err}`,
        })),
      }
    }

    // Get the issue writer agent
    const agent = mastra?.getAgent("issueWriterAgent")

    const results: Array<{ title: string; issueUrl: string | null; error: string | null }> = []
    let created = 0

    for (const anomaly of anomalies) {
      const targetRepo = resolveTargetRepo(anomaly)

      if (!targetRepo) {
        await recordAnomaly(inputData.orgId, anomaly, null, null, null)
        results.push({ title: anomaly.title, issueUrl: null, error: "No target repo" })
        continue
      }

      try {
        let issueTitle: string
        let issueBody: string

        if (agent) {
          // Use LLM agent to write a rich issue
          const prompt = buildAgentPrompt(anomaly, config.MAPLE_DASHBOARD_URL)
          const response = await agent.generate([{ role: "user", content: prompt }])

          // Parse the agent's JSON response
          const text = typeof response.text === "string" ? response.text : String(response.text)
          const parsed = parseAgentResponse(text, anomaly)
          issueTitle = parsed.title
          issueBody = parsed.body
        } else {
          // Fallback: use static template (same as original agent)
          issueTitle = anomaly.title
          issueBody = buildStaticIssueBody(anomaly, config.MAPLE_DASHBOARD_URL)
        }

        const issue = await createGitHubIssue(
          token,
          targetRepo.owner,
          targetRepo.name,
          issueTitle,
          issueBody,
          anomaly.kind,
          anomaly.severity,
        )

        await recordAnomaly(
          inputData.orgId,
          anomaly,
          issue.number,
          issue.url,
          targetRepo.fullName,
        )

        console.log(
          `[createIssues] Created issue #${issue.number} in ${targetRepo.fullName}: ${issueTitle}`,
        )

        results.push({ title: issueTitle, issueUrl: issue.url, error: null })
        created++
      } catch (err) {
        console.error(`[createIssues] Failed to create issue for "${anomaly.title}":`, err)
        await recordAnomaly(inputData.orgId, anomaly, null, null, null).catch(() => {})
        results.push({
          title: anomaly.title,
          issueUrl: null,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { created, results }
  },
})

// --- Helper functions ---

function buildAgentPrompt(anomaly: EnrichedAnomaly, dashboardUrl: string): string {
  const sections: string[] = []

  sections.push(`Write a GitHub issue for the following anomaly.\n`)
  sections.push(`**Anomaly Kind:** ${anomaly.kind}`)
  sections.push(`**Severity:** ${anomaly.severity}`)
  sections.push(`**Detected At:** ${anomaly.detectedAt}`)
  sections.push(`**Organization ID:** (used for Tinybird queries if you need more data)\n`)
  sections.push(`**Description:** ${anomaly.description}\n`)

  sections.push(`**Metrics:**`)
  sections.push(`- Current value: ${anomaly.currentValue}`)
  if (anomaly.baselineValue !== undefined) {
    sections.push(`- Baseline value: ${anomaly.baselineValue}`)
  }
  sections.push(`- Threshold: ${anomaly.thresholdValue}`)

  if (anomaly.affectedServices.length > 0) {
    sections.push(`\n**Affected Services:** ${anomaly.affectedServices.join(", ")}`)
  }
  if (anomaly.serviceName) {
    sections.push(`**Primary Service:** ${anomaly.serviceName}`)
  }

  if (anomaly.sampleTraces.length > 0) {
    sections.push(`\n**Sample Traces:**`)
    for (const trace of anomaly.sampleTraces) {
      sections.push(
        `- Trace ${trace.traceId}: ${trace.rootSpanName} (${trace.durationMs}ms, ${trace.serviceName}, status: ${trace.statusCode})`,
      )
      sections.push(`  Dashboard link: ${dashboardUrl}/traces/${trace.traceId}`)
    }
  }

  if (anomaly.correlatedLogs.length > 0) {
    sections.push(`\n**Correlated Logs (sample):**`)
    sections.push("```")
    for (const log of anomaly.correlatedLogs.slice(0, 5)) {
      sections.push(`[${log.timestamp}] [${log.severity}] [${log.serviceName}] ${log.body}`)
    }
    sections.push("```")
  }

  sections.push(`\n**Dashboard URL for trace links:** ${dashboardUrl}`)
  sections.push(
    `\nRespond with a JSON object containing "title", "body", and "severity" fields. The body should be Markdown.`,
  )

  return sections.join("\n")
}

function parseAgentResponse(
  text: string,
  anomaly: EnrichedAnomaly,
): { title: string; body: string } {
  try {
    // Try to extract JSON from the response (may be wrapped in ```json blocks)
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, text]
    const jsonStr = jsonMatch[1] || text

    const parsed = JSON.parse(jsonStr) as { title?: string; body?: string }
    return {
      title: parsed.title || anomaly.title,
      body: parsed.body || buildStaticIssueBody(anomaly, ""),
    }
  } catch {
    // If JSON parsing fails, use the raw text as the body
    return {
      title: anomaly.title,
      body: text || buildStaticIssueBody(anomaly, ""),
    }
  }
}

function buildStaticIssueBody(anomaly: EnrichedAnomaly, dashboardUrl: string): string {
  const sections: string[] = []

  sections.push(`## Anomaly Detected by Maple Agent\n`)
  sections.push(`**Kind:** ${anomaly.kind.replace(/_/g, " ")}`)
  sections.push(`**Severity:** ${anomaly.severity}`)
  sections.push(`**Detected at:** ${anomaly.detectedAt}\n`)
  sections.push(`### Description\n`)
  sections.push(anomaly.description)

  sections.push(`\n### Metrics\n`)
  sections.push(`| Metric | Value |`)
  sections.push(`|--------|-------|`)
  sections.push(`| Current value | ${anomaly.currentValue} |`)
  if (anomaly.baselineValue !== undefined) {
    sections.push(`| Baseline value | ${anomaly.baselineValue} |`)
  }
  sections.push(`| Threshold | ${anomaly.thresholdValue} |`)

  if (anomaly.affectedServices.length > 0) {
    sections.push(`\n### Affected Services\n`)
    for (const service of anomaly.affectedServices) {
      sections.push(`- \`${service}\``)
    }
  }

  if (anomaly.sampleTraces && anomaly.sampleTraces.length > 0) {
    sections.push(`\n### Sample Traces\n`)
    for (const trace of anomaly.sampleTraces) {
      const link = dashboardUrl ? `${dashboardUrl}/traces/${trace.traceId}` : trace.traceId
      sections.push(
        `- [${trace.rootSpanName}](${link}) — ${trace.durationMs}ms, ${trace.serviceName} (${trace.statusCode})`,
      )
    }
  } else if (anomaly.sampleTraceIds && anomaly.sampleTraceIds.length > 0) {
    sections.push(`\n### Sample Trace IDs\n`)
    for (const traceId of anomaly.sampleTraceIds) {
      if (dashboardUrl) {
        sections.push(`- [${traceId}](${dashboardUrl}/traces/${traceId})`)
      } else {
        sections.push(`- \`${traceId}\``)
      }
    }
  }

  if (anomaly.correlatedLogs && anomaly.correlatedLogs.length > 0) {
    sections.push(`\n### Correlated Logs\n`)
    sections.push("```")
    for (const log of anomaly.correlatedLogs.slice(0, 5)) {
      sections.push(`[${log.timestamp}] [${log.severity}] [${log.serviceName}] ${log.body}`)
    }
    sections.push("```")
  }

  sections.push(
    `\n---\n*This issue was automatically created by the [Maple](https://github.com/mapleai/maple) anomaly detection agent.*`,
  )

  return sections.join("\n")
}

// --- Workflow Definition ---

const anomalyDetectionWorkflow = createWorkflow({
  id: "anomaly-detection",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID to run detection for"),
  }),
  outputSchema: z.object({
    created: z.number(),
    results: z.array(
      z.object({
        title: z.string(),
        issueUrl: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
})
  .then(detect)
  .then(deduplicate)
  .then(enrich)
  .then(createIssues)

anomalyDetectionWorkflow.commit()

export { anomalyDetectionWorkflow }
