import { ChatApplyRequest } from "@maple/domain/http"

/**
 * `POST /api/chat/apply`'s payload.
 *
 * The `origin` triple is optional because the endpoint is a public v1 contract, but the web client
 * always sends it: without it the applied mutation never lands back in the transcript, so the
 * approval card stays unresolved and the agent's next turn is never told the change went through.
 */
export const makeChatApplyPayload = (
	tool: string,
	input: unknown,
	origin?: {
		readonly sessionId: string | undefined
		readonly messageId: string
		readonly toolCallId: string
	},
): ChatApplyRequest =>
	new ChatApplyRequest({
		tool,
		input,
		...(!(origin?.sessionId === undefined)
			? {
					sessionId: origin.sessionId,
					messageId: origin.messageId,
					toolCallId: origin.toolCallId,
				}
			: undefined),
	})
