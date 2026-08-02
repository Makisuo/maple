import { describe, expect, test } from "vitest"
import { LLM, LLMClient, Provider } from "@maple/llm"
import { Route, Protocol } from "@maple/llm/route"
import { Provider as ProviderSubpath } from "@maple/llm/provider"
import {
  CloudflareAIGateway,
  CloudflareWorkersAI,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
  XAI,
} from "@maple/llm/providers"
import * as GitHubCopilot from "@maple/llm/providers/github-copilot"
import { OpenAIChat, OpenAICompatibleChat, OpenAIResponses } from "@maple/llm/protocols"
import * as AnthropicMessages from "@maple/llm/protocols/anthropic-messages"

describe("public exports", () => {
  test("root exposes app-facing runtime APIs", () => {
    expect(typeof LLM.request).toBe("function")
    expect(typeof LLMClient.Service).toBe("function")
    expect(LLMClient.layer).toBeDefined()
    expect(typeof Provider.make).toBe("function")
    expect(ProviderSubpath.make).toBe(Provider.make)
  })

  test("route barrel exposes route-authoring APIs", () => {
    expect(typeof Route.make).toBe("function")
    expect(typeof Protocol.make).toBe("function")
  })

  test("provider barrels expose user-facing facades", () => {
    expect(typeof OpenAI.model).toBe("function")
    expect(OpenAI.provider.model).toBe(OpenAI.model)
    expect(OpenAI.provider.responses).toBe(OpenAI.responses)
    expect(OpenAI.provider.responsesWebSocket).toBe(OpenAI.responsesWebSocket)
    expect(typeof OpenAI.configure({ apiKey: "fixture" }).responses).toBe("function")
    expect(typeof OpenAICompatible.deepseek.model).toBe("function")
    expect(typeof CloudflareAIGateway.configure).toBe("function")
    expect(typeof CloudflareAIGateway.configure({ accountId: "fixture", gatewayApiKey: "fixture" }).model).toBe("function")
    expect(typeof CloudflareWorkersAI.configure).toBe("function")
    expect(typeof CloudflareWorkersAI.configure({ accountId: "fixture", apiKey: "fixture" }).model).toBe("function")
    expect(typeof OpenRouter.model).toBe("function")
    expect(OpenRouter.provider.model).toBe(OpenRouter.model)
    expect(typeof XAI.model).toBe("function")
    expect(XAI.provider.model).toBe(XAI.model)
    expect(XAI.provider.responses).toBe(XAI.responses)
    expect(XAI.provider.chat).toBe(XAI.chat)
    expect(XAI.configure({ apiKey: "fixture" }).responses("grok-4.3").route.id).toBe("openai-responses")
    expect(XAI.configure({ apiKey: "fixture" }).chat("grok-4.3").route.id).toBe("openai-compatible-chat")
    expect(typeof 
      GitHubCopilot.configure({ baseURL: "https://api.githubcopilot.test", apiKey: "fixture" }).model,
    ).toBe("function")
    expect(
      GitHubCopilot.configure({
        baseURL: "https://api.githubcopilot.test",
        apiKey: "fixture",
        endpoint: "responses",
      }).model("mai-code-1-flash-picker").route.id,
    ).toBe("openai-responses")
    expect(
      GitHubCopilot.configure({
        baseURL: "https://api.githubcopilot.test",
        apiKey: "fixture",
        endpoint: "chat",
      }).model("gpt-5").route.id,
    ).toBe("openai-chat")
  })

  test("protocol barrels expose supported low-level routes", () => {
    expect(OpenAIChat.route.id).toBe("openai-chat")
    expect(OpenAICompatibleChat.route.id).toBe("openai-compatible-chat")
    expect(OpenAIResponses.route.id).toBe("openai-responses")
    expect(OpenAIResponses.webSocketRoute.id).toBe("openai-responses-websocket")
    expect(AnthropicMessages.route.id).toBe("anthropic-messages")
  })
})
