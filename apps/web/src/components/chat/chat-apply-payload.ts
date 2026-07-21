import { ChatApplyRequest } from "@maple/domain/http"

export const makeChatApplyPayload = (tool: string, input: unknown): ChatApplyRequest =>
	new ChatApplyRequest({ tool, input })
