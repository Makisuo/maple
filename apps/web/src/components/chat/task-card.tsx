import { useState } from "react"
import {
	ChatBubbleSparkleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	LoaderIcon,
} from "@/components/icons"
import { Tool } from "@/components/ai-elements/tool"
import { RichText } from "@/components/ai-elements/rich-text"
import type { UIMessage } from "@/components/ai-elements/types"
import { toolNameFor, type ToolPart } from "./transcript-rows"

type TaskStatus = "running" | "completed" | "error" | "aborted"

interface TaskCardProps {
	agent: string
	description: string
	status: TaskStatus
	messages: readonly UIMessage[]
}

const STATUS_ICON: Record<TaskStatus, typeof CircleCheckIcon> = {
	running: LoaderIcon,
	completed: CircleCheckIcon,
	error: CircleXmarkIcon,
	aborted: CircleXmarkIcon,
} satisfies Record<TaskStatus, typeof CircleCheckIcon>

const STATUS_TINT: Record<TaskStatus, string> = {
	running: "text-muted-foreground",
	completed: "text-success",
	error: "text-destructive",
	aborted: "text-muted-foreground",
} satisfies Record<TaskStatus, string>

const toolCount = (messages: readonly UIMessage[]): number =>
	messages.reduce(
		(total, message) => total + message.parts.filter((part) => part.type === "dynamic-tool").length,
		0,
	)

/**
 * One sub-agent run, collapsed.
 *
 * Collapsed by default because the whole point of delegating is that the parent conversation does
 * not have to carry the sub-agent's search. Its answer already reached the model through the tool
 * result; this card is for a reader who wants to check the work.
 */
export function TaskCard({ agent, description, status, messages }: TaskCardProps) {
	const [open, setOpen] = useState(false)
	const Icon = STATUS_ICON[status]
	const tools = toolCount(messages)

	return (
		<div className="overflow-hidden rounded-xl border bg-muted/20 text-xs">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
			>
				{open ? (
					<ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
				)}
				<ChatBubbleSparkleIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="font-medium">{agent}</span>
				<span className="truncate text-muted-foreground">{description}</span>
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
					{tools > 0 ? <span>{tools === 1 ? "1 tool" : `${tools} tools`}</span> : null}
					<Icon
						className={`size-3.5 ${STATUS_TINT[status]} ${status === "running" ? "animate-spin" : ""}`}
					/>
				</span>
			</button>

			{open ? (
				<div className="flex flex-col gap-2 border-t bg-background/50 p-3">
					{messages.length === 0 ? (
						<p className="text-muted-foreground">Nothing yet.</p>
					) : (
						messages.map((message) => (
							<div key={message.id} className="flex flex-col gap-2">
								{message.parts.map((part, index) =>
									part.type === "text" ? (
										<RichText key={`text-${index}`}>{part.text}</RichText>
									) : part.type === "dynamic-tool" ? (
										<Tool
											key={part.toolCallId}
											toolName={toolNameFor(part as ToolPart)}
											toolCallId={part.toolCallId}
											state={part.state}
											input={part.input}
											output={"output" in part ? part.output : undefined}
											errorText={"errorText" in part ? part.errorText : undefined}
										/>
									) : null,
								)}
							</div>
						))
					)}
				</div>
			) : null}
		</div>
	)
}
