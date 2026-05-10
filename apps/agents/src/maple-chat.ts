import type {
	EntityRegistry,
	HandlerContext,
	LLMMessage,
	StateCollectionProxy,
	TimelineItem,
} from "@electric-ax/agents-runtime"
import { getModel, type Model } from "@mariozechner/pi-ai"
import { z } from "zod"
import {
	DASHBOARD_BUILDER_SYSTEM_PROMPT,
	ELECTRIC_OPENROUTER_MODEL_ID,
	MAPLE_CHAT_ENTITY_TYPE,
	SYSTEM_PROMPT,
	trackTokenUsage,
	withMapleContext,
	type MapleChatContextInput,
} from "@maple/ai"
import { resolveOrgOpenrouterKey } from "@maple/api/agent"
import type { AgentsEnv } from "./env"
import { createMapleElectricTools, executeApprovedMapleTool } from "./maple-tools"

const ChatCreationSchema = z.object({
	orgId: z.string().min(1),
	tabId: z.string().min(1),
	userId: z.string().min(1),
	title: z.string().optional(),
})

const ChatMessageSchema = z.object({
	text: z.string().min(1),
	mode: z.string().optional(),
	pageContext: z.unknown().optional(),
	alertContext: z.unknown().optional(),
	widgetFixContext: z.unknown().optional(),
	dashboardContext: z.unknown().optional(),
})

const ApprovalResponseSchema = z.object({
	approvalId: z.string().min(1),
	approved: z.boolean(),
})

export const ApprovalRequestRowSchema = z.object({
	id: z.string(),
	toolCallId: z.string(),
	toolName: z.string(),
	args: z.unknown(),
	status: z.enum(["pending", "approved", "denied", "executed", "failed"]),
	createdAt: z.number(),
	resolvedAt: z.number().optional(),
	result: z.string().optional(),
	error: z.string().optional(),
})

type ChatCreation = z.infer<typeof ChatCreationSchema>
type ChatMessage = z.infer<typeof ChatMessageSchema>
type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>
type ApprovalRow = z.infer<typeof ApprovalRequestRowSchema>

const ChatState = {
	approvalRequests: {
		schema: ApprovalRequestRowSchema,
		type: "approval_request",
		primaryKey: "id" as const,
	},
} as const

// Custom ctx alias — the SDK's StateProxy constraint requires
// StateCollectionProxy<Record<string, unknown>>, but our typed Zod schema
// would narrow the row covariantly, which conflicts with the proxy's
// invariant `update(_, draft => ...)` signature. We widen the row type to
// match the constraint and downcast inside helpers.
type AnyStateProxy = Record<string, StateCollectionProxy>
type ChatCtx = HandlerContext<AnyStateProxy, ChatCreation>
type ApprovalCollection = StateCollectionProxy<ApprovalRow, ApprovalRow, string>

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}

const latestInboxPayload = (ctx: ChatCtx): unknown => {
	const inbox = ctx.db.collections.inbox.toArray
	return inbox.at(-1)?.payload
}

const approvalCollection = (ctx: ChatCtx): ApprovalCollection =>
	ctx.state.approvalRequests as unknown as ApprovalCollection

const parseChatContext = (payload: ChatMessage): MapleChatContextInput => ({
	mode: payload.mode,
	pageContext: payload.pageContext as MapleChatContextInput["pageContext"],
	alertContext: payload.alertContext as MapleChatContextInput["alertContext"],
	widgetFixContext: payload.widgetFixContext as MapleChatContextInput["widgetFixContext"],
	dashboardContext: payload.dashboardContext as MapleChatContextInput["dashboardContext"],
})

const projectMapleTimeline = (item: TimelineItem): LLMMessage[] | null => {
	if (item.kind !== "inbox") return null
	const payload = asRecord(item.payload)
	if (typeof payload.text === "string") {
		return [{ role: "user", content: payload.text }]
	}
	return null
}

const resolveApiKey = async (
	env: AgentsEnv,
	orgId: string,
): Promise<{ apiKey: string; isByok: boolean }> => {
	const orgKey = await resolveOrgOpenrouterKey(env as Record<string, unknown>, orgId, {
		database: "libsql",
	})
	const apiKey = orgKey ?? env.OPENROUTER_API_KEY
	if (!apiKey) {
		throw new Error("No OpenRouter API key configured. An admin must add one in Settings -> AI.")
	}
	return { apiKey, isByok: orgKey !== undefined }
}

const openRouterModel = () =>
	getModel("openrouter", ELECTRIC_OPENROUTER_MODEL_ID as never) as Model<"openai-completions">

const selectSystemPrompt = (mode: string | undefined): string =>
	mode === "dashboard_builder" ? DASHBOARD_BUILDER_SYSTEM_PROMPT : SYSTEM_PROMPT

const runApprovalResponse = async (
	ctx: ChatCtx,
	env: AgentsEnv,
	args: ChatCreation,
	response: ApprovalResponse,
) => {
	const approvalRequests = approvalCollection(ctx)
	const row = approvalRequests.get(response.approvalId)
	const run = ctx.recordRun()
	if (!row) {
		run.attachResponse("Approval request was not found or has expired.")
		run.end({ status: "failed", finishReason: "approval_missing" })
		return
	}

	if (!response.approved) {
		approvalRequests.update(response.approvalId, (draft) => {
			draft.status = "denied"
			draft.resolvedAt = Date.now()
		})
		run.attachResponse("Denied. I did not run the requested action.")
		run.end({ status: "completed", finishReason: "approval_denied" })
		return
	}

	approvalRequests.update(response.approvalId, (draft) => {
		draft.status = "approved"
		draft.resolvedAt = Date.now()
	})

	try {
		const result = await executeApprovedMapleTool(
			env as Record<string, unknown>,
			args.orgId,
			row.toolName,
			row.args,
		)
		approvalRequests.update(response.approvalId, (draft) => {
			draft.status = "executed"
			draft.result = result
			draft.resolvedAt = Date.now()
		})
		run.attachResponse(result)
		run.end({ status: "completed", finishReason: "approval_executed" })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		approvalRequests.update(response.approvalId, (draft) => {
			draft.status = "failed"
			draft.error = message
			draft.resolvedAt = Date.now()
		})
		run.attachResponse(`Failed to run approved action: ${message}`)
		run.end({ status: "failed", finishReason: "approval_failed" })
	}
}

export const registerMapleChatEntity = (registry: EntityRegistry, env: AgentsEnv) => {
	registry.define(MAPLE_CHAT_ENTITY_TYPE, {
		description: "Maple AI chat backed by Electric Agents",
		creationSchema: ChatCreationSchema,
		inboxSchemas: {
			user_message: ChatMessageSchema.toJSONSchema(),
			approval_response: ApprovalResponseSchema.toJSONSchema(),
		},
		state: ChatState,
		async handler(ctx) {
			const args = ChatCreationSchema.parse(ctx.args)
			const payload = latestInboxPayload(ctx as unknown as ChatCtx)

			if (ctx.events.some((event) => event.type === "message_received")) {
				const approval = ApprovalResponseSchema.safeParse(payload)
				if (approval.success) {
					await runApprovalResponse(ctx as unknown as ChatCtx, env, args, approval.data)
					return
				}
			}

			const message = ChatMessageSchema.safeParse(payload)
			if (!message.success) {
				if (payload !== undefined) {
					console.warn(
						`[maple-chat] Ignoring unrecognized payload on ${ctx.entityUrl}: ${message.error.issues
							.map((i) => `${i.path.join(".")}: ${i.message}`)
							.join(", ")}`,
					)
				}
				ctx.sleep()
				return
			}

			const { apiKey, isByok } = await resolveApiKey(env, args.orgId)
			const chatContext = parseChatContext(message.data)
			const systemPrompt = withMapleContext(selectSystemPrompt(chatContext.mode), chatContext)
			const mapleTools = await createMapleElectricTools(
				{
					entityUrl: ctx.entityUrl,
					approvalRequests: approvalCollection(ctx as unknown as ChatCtx),
				},
				{
					env: env as Record<string, unknown>,
					orgId: args.orgId,
				},
			)

			ctx.useContext({
				sourceBudget: 100_000,
				sources: {
					timeline: {
						cache: "volatile",
						content: () => ctx.timelineMessages({ projection: projectMapleTimeline }),
					},
				},
			})

			ctx.useAgent({
				systemPrompt,
				model: openRouterModel(),
				provider: "openrouter",
				getApiKey: (provider) => (provider === "openrouter" ? apiKey : undefined),
				tools: [...ctx.electricTools, ...mapleTools],
			})

			const turnId = crypto.randomUUID()
			const result = await ctx.agent.run()

			if (!isByok && result.usage.tokens > 0) {
				// The SDK exposes aggregate token usage only — no input/output split.
				// We attribute everything to ai_output_tokens because output dominates
				// LLM pricing in practice and avoids systematically under-billing.
				await trackTokenUsage(env, {
					orgId: args.orgId,
					inputTokens: 0,
					outputTokens: result.usage.tokens,
					idempotencyKey: turnId,
					source: "chat",
				})
			}
		},
	})
}
