function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback
}

function optionalNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return fallback
  return parsed
}

export function getConfig() {
  return {
    // Tinybird
    TINYBIRD_HOST: optionalEnv("TINYBIRD_HOST", "https://api.tinybird.co"),
    TINYBIRD_TOKEN: requireEnv("TINYBIRD_TOKEN"),

    // Database
    MAPLE_DB_URL: optionalEnv("MAPLE_DB_URL", ""),
    MAPLE_DB_AUTH_TOKEN: optionalEnv("MAPLE_DB_AUTH_TOKEN", ""),

    // GitHub App
    GITHUB_APP_ID: optionalEnv("GITHUB_APP_ID", ""),
    GITHUB_APP_PRIVATE_KEY: optionalEnv("GITHUB_APP_PRIVATE_KEY", ""),

    // Detection tuning
    AGENT_INTERVAL_SECONDS: optionalNumber("AGENT_INTERVAL_SECONDS", 300),
    AGENT_DETECTION_WINDOW_MINUTES: optionalNumber("AGENT_DETECTION_WINDOW_MINUTES", 15),
    AGENT_ERROR_RATE_SPIKE_MULTIPLIER: optionalNumber("AGENT_ERROR_RATE_SPIKE_MULTIPLIER", 2.0),
    AGENT_ERROR_RATE_ABSOLUTE_THRESHOLD: optionalNumber("AGENT_ERROR_RATE_ABSOLUTE_THRESHOLD", 5),
    AGENT_LATENCY_SPIKE_MULTIPLIER: optionalNumber("AGENT_LATENCY_SPIKE_MULTIPLIER", 1.5),
    AGENT_APDEX_THRESHOLD: optionalNumber("AGENT_APDEX_THRESHOLD", 0.7),
    AGENT_COOLDOWN_HOURS: optionalNumber("AGENT_COOLDOWN_HOURS", 4),

    // Dashboard URL for trace links
    MAPLE_DASHBOARD_URL: optionalEnv("MAPLE_DASHBOARD_URL", "https://maple.dev"),
  } as const
}

export type Config = ReturnType<typeof getConfig>
