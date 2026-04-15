export type MapleStage =
  | { kind: "prd" }
  | { kind: "stg" }
  | { kind: "pr"; prNumber: number }

const PR_STAGE_RE = /^pr-(\d+)$/

export interface MapleDomains {
  web?: string
  landing?: string
  api?: string
  ingest?: string
  chat?: string
}

const PRD_DOMAINS: MapleDomains = {
  web: "app.maple.dev",
  api: "api.maple.dev",
  ingest: "ingest.maple.dev",
  chat: "chat.maple.dev",
  landing: "maple.dev",
}

const STG_DOMAINS: MapleDomains = {
  web: "staging.maple.dev",
  api: "api-staging.maple.dev",
  ingest: "ingest-staging.maple.dev",
  chat: "chat-staging.maple.dev",
  landing: "staging-landing.maple.dev",
}

export function parseMapleStage(stage: string): MapleStage {
  const normalized = stage.trim().toLowerCase()

  if (normalized === "prd") {
    return { kind: "prd" }
  }

  if (normalized === "stg") {
    return { kind: "stg" }
  }

  const prMatch = normalized.match(PR_STAGE_RE)
  if (prMatch) {
    const prNumber = Number(prMatch[1])
    if (Number.isSafeInteger(prNumber) && prNumber > 0) {
      return { kind: "pr", prNumber }
    }
  }

  throw new Error(
    `Unsupported deployment stage "${stage}". Expected one of: prd, stg, pr-<number>.`,
  )
}

export function formatMapleStage(stage: MapleStage): string {
  switch (stage.kind) {
    case "prd":
      return "prd"
    case "stg":
      return "stg"
    case "pr":
      return `pr-${stage.prNumber}`
  }
}

export function resolveMapleDomains(stage: MapleStage): MapleDomains {
  switch (stage.kind) {
    case "prd":
      return PRD_DOMAINS
    case "stg":
      return STG_DOMAINS
    case "pr":
      return {}
  }
}

export function resolveD1Name(stage: MapleStage): string {
  switch (stage.kind) {
    case "prd":
      return "maple-api"
    case "stg":
      return "maple-api-stg"
    case "pr":
      return `maple-api-pr-${stage.prNumber}`
  }
}

export function resolveWorkerName(base: string, stage: MapleStage): string {
  switch (stage.kind) {
    case "prd":
      return `maple-${base}`
    case "stg":
      return `maple-${base}-stg`
    case "pr":
      return `maple-${base}-pr-${stage.prNumber}`
  }
}
