import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Button } from "@maple/ui/components/ui/button"
import { CheckIcon, CopyIcon, PlusIcon } from "@/components/icons"
import { mcpUrl } from "@/lib/services/common/mcp-url"
import { McpToolsList } from "@/components/mcp/mcp-tools-list"
import { CreateApiKeyDialog } from "@/components/settings/create-api-key-dialog"
import { CodeBlock } from "@/components/quick-start/code-block"

const mcpEndpoint = `${mcpUrl}/mcp`

function generateConfig(
  client: "claude-code" | "cursor" | "windsurf" | "other",
  apiKey: string,
) {
  const urlKey = client === "windsurf" ? "serverUrl" : "url"
  const config = {
    mcpServers: {
      maple: {
        [urlKey]: mcpEndpoint,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    },
  }
  return JSON.stringify(config, null, 2)
}

function generateCliCommand(apiKey: string) {
  return `claude mcp add --transport http maple ${mcpEndpoint} \\
  --header "Authorization: Bearer ${apiKey}"`
}

const CONFIG_FILE_HINTS: Record<string, string> = {
  "claude-code": "~/.claude/claude_desktop_config.json",
  cursor: ".cursor/mcp.json",
  windsurf: "~/.codeium/windsurf/mcp_config.json",
  other: "",
}

export function McpSection() {
  const [endpointCopied, setEndpointCopied] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [configTab, setConfigTab] = useState("claude-code")

  const apiKeyPlaceholder = createdSecret ?? "<your-api-key>"

  async function handleCopyEndpoint() {
    try {
      await navigator.clipboard.writeText(mcpEndpoint)
      setEndpointCopied(true)
      toast.success("MCP endpoint copied to clipboard")
      setTimeout(() => setEndpointCopied(false), 2000)
    } catch {
      toast.error("Failed to copy endpoint")
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Server Endpoint</CardTitle>
          <CardDescription>
            Use this URL to connect MCP-compatible clients to Maple.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InputGroup>
            <InputGroupInput
              readOnly
              value={mcpEndpoint}
              className="font-mono text-xs tracking-wide select-all"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                onClick={handleCopyEndpoint}
                aria-label="Copy endpoint to clipboard"
                title={endpointCopied ? "Copied!" : "Copy"}
              >
                {endpointCopied ? (
                  <CheckIcon size={14} className="text-severity-info" />
                ) : (
                  <CopyIcon size={14} />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground text-xs">
              Authenticate with an API key.
            </p>
            {createdSecret ? (
              <p className="text-severity-info text-xs font-medium">
                Key created — config below is ready to copy.
              </p>
            ) : (
              <Button
                variant="outline"
                size="xs"
                onClick={() => setCreateDialogOpen(true)}
              >
                <PlusIcon size={12} />
                Create API Key
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Setup</CardTitle>
          <CardDescription>
            Copy the configuration for your editor and paste it into the
            config file.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={configTab} onValueChange={setConfigTab}>
            <TabsList variant="line">
              <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
              <TabsTrigger value="cursor">Cursor</TabsTrigger>
              <TabsTrigger value="windsurf">Windsurf</TabsTrigger>
              <TabsTrigger value="other">Other</TabsTrigger>
            </TabsList>
            <TabsContent value="claude-code" className="pt-3">
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">
                    Run in your terminal
                  </p>
                  <CodeBlock
                    code={generateCliCommand(apiKeyPlaceholder)}
                    language="bash"
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">
                    Or add to{" "}
                    <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
                      {CONFIG_FILE_HINTS["claude-code"]}
                    </code>
                  </p>
                  <CodeBlock
                    code={generateConfig("claude-code", apiKeyPlaceholder)}
                    language="json"
                  />
                </div>
              </div>
            </TabsContent>
            {(["cursor", "windsurf", "other"] as const).map(
              (client) => (
                <TabsContent key={client} value={client} className="pt-3">
                  <div className="space-y-2">
                    {CONFIG_FILE_HINTS[client] && (
                      <p className="text-muted-foreground text-xs">
                        Add to{" "}
                        <code className="bg-muted px-1 py-0.5 rounded text-[11px]">
                          {CONFIG_FILE_HINTS[client]}
                        </code>
                      </p>
                    )}
                    <CodeBlock
                      code={generateConfig(client, apiKeyPlaceholder)}
                      language="json"
                    />
                  </div>
                </TabsContent>
              ),
            )}
          </Tabs>
          {!createdSecret && (
            <p className="text-muted-foreground text-xs mt-3">
              Need an API key?{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 hover:no-underline"
                onClick={() => setCreateDialogOpen(true)}
              >
                Create one
              </button>{" "}
              or manage existing keys in{" "}
              <Link
                to="/settings"
                search={{ tab: "api-keys" }}
                className="text-foreground underline underline-offset-2 hover:no-underline"
              >
                API Keys
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>

      <McpToolsList />

      <CreateApiKeyDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(secret) => setCreatedSecret(secret)}
      />
    </div>
  )
}
