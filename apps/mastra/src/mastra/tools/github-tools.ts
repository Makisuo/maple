import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { createGitHubIssue, getInstallationToken } from "../lib/github"

export const createGitHubIssueTool = createTool({
  id: "create-github-issue",
  description: "Create a GitHub issue in a repository using GitHub App authentication",
  inputSchema: z.object({
    installationId: z.number().describe("GitHub App installation ID"),
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Issue title"),
    body: z.string().describe("Issue body in Markdown"),
    kind: z.string().describe("Anomaly kind for labeling (e.g., error_rate_spike)"),
    severity: z.string().describe("Severity level (critical, warning, info)"),
  }),
  outputSchema: z.object({
    number: z.number(),
    url: z.string(),
  }),
  execute: async (input) => {
    const token = await getInstallationToken(input.installationId)
    return createGitHubIssue(
      token,
      input.owner,
      input.repo,
      input.title,
      input.body,
      input.kind,
      input.severity,
    )
  },
})

export const githubTools = {
  createGitHubIssueTool,
}
