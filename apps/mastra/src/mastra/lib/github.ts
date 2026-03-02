import { createSign } from "node:crypto"
import { getConfig } from "./config"

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }),
  ).toString("base64url")

  const sign = createSign("RSA-SHA256")
  sign.update(`${header}.${payload}`)
  const signature = sign.sign(privateKey, "base64url")

  return `${header}.${payload}.${signature}`
}

const GITHUB_API = "https://api.github.com"
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const config = getConfig()
  const jwt = createAppJwt(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY)

  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...GITHUB_HEADERS,
      },
    },
  )

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API ${response.status}: ${body}`)
  }

  const data = (await response.json()) as { token: string }
  return data.token
}

const LABELS = [
  { name: "maple-agent", color: "5319e7", description: "Created by Maple anomaly agent" },
  { name: "severity:critical", color: "d73a49", description: "Critical severity" },
  { name: "severity:warning", color: "e36209", description: "Warning severity" },
  { name: "severity:info", color: "0366d6", description: "Info severity" },
  { name: "kind:error-rate-spike", color: "fbca04", description: "Error rate spike anomaly" },
  { name: "kind:new-error-type", color: "fbca04", description: "New error type anomaly" },
  { name: "kind:latency-degradation", color: "fbca04", description: "Latency degradation anomaly" },
  { name: "kind:apdex-drop", color: "fbca04", description: "Apdex drop anomaly" },
]

const KIND_LABEL_MAP: Record<string, string> = {
  error_rate_spike: "error-rate-spike",
  new_error_type: "new-error-type",
  latency_degradation: "latency-degradation",
  apdex_drop: "apdex-drop",
}

async function ensureLabels(token: string, owner: string, repo: string): Promise<void> {
  for (const label of LABELS) {
    try {
      const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/labels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...GITHUB_HEADERS,
        },
        body: JSON.stringify(label),
      })
      // 422 = label already exists, that's fine
      if (!response.ok && response.status !== 422) {
        // Ignore label creation errors — non-critical
      }
    } catch {
      // Ignore
    }
  }
}

export async function createGitHubIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  kind: string,
  severity: string,
): Promise<{ number: number; url: string }> {
  await ensureLabels(token, owner, repo)

  const kindLabel = KIND_LABEL_MAP[kind] ?? kind
  const labels = ["maple-agent", `severity:${severity}`, `kind:${kindLabel}`]

  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...GITHUB_HEADERS,
    },
    body: JSON.stringify({ title, body, labels }),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`GitHub API ${response.status}: ${responseBody}`)
  }

  const data = (await response.json()) as { number: number; html_url: string }
  return { number: data.number, url: data.html_url }
}
