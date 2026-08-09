import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

/**
 * Apply an approval-gated AI chat proposal.
 *
 * The agent's turn *stops* on a mutating tool and records a `tool-call` with `proposed: true` and
 * no result — nothing fabricates an outcome. This endpoint is where the mutation actually happens,
 * on the user's click, authenticated as the user: it re-runs the named MCP tool under the caller's
 * org, reusing the exact tool implementation so each mutation has one source of truth.
 *
 * `sessionId` and `toolCallId` close the loop. Without them the applied result never reached the
 * transcript: the proposal stayed output-less forever, and the model's next turn was never told
 * the mutation happened — the precise failure the interrupt design exists to avoid.
 */
export class ChatApplyRequest extends Schema.Class<ChatApplyRequest>("ChatApplyRequest")({
	/** MCP tool base name, e.g. `update_dashboard_widget`. */
	tool: Schema.String,
	/** The proposed tool input (validated against the tool's own schema server-side). */
	input: Schema.Unknown,
	/** The conversation this proposal came from, so the outcome can be recorded against it. */
	sessionId: Schema.optionalKey(Schema.String),
	/** The assistant message that issued the proposal — the result attaches to it. */
	messageId: Schema.optionalKey(Schema.String),
	/** The proposed call's id, so the outcome settles that call rather than appearing loose. */
	toolCallId: Schema.optionalKey(Schema.String),
}) {}

export class ChatApplyResponse extends Schema.Class<ChatApplyResponse>("ChatApplyResponse")({
	/** Human-readable result text from the tool (joined content). */
	content: Schema.String,
	/** True when the tool ran but reported a domain-level error (e.g. validation). */
	isError: Schema.optionalKey(Schema.Boolean),
}) {}

export class ChatToolNotFoundError extends Schema.TaggedError<ChatToolNotFoundError>()(
	"@maple/http/errors/ChatToolNotFoundError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class ChatToolNotApplicableError extends Schema.TaggedError<ChatToolNotApplicableError>()(
	"@maple/http/errors/ChatToolNotApplicableError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ChatToolInvalidInputError extends Schema.TaggedError<ChatToolInvalidInputError>()(
	"@maple/http/errors/ChatToolInvalidInputError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ChatToolExecutionError extends Schema.TaggedError<ChatToolExecutionError>()(
	"@maple/http/errors/ChatToolExecutionError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

export class ChatApiGroup extends HttpApiGroup.make("chat")
	.add(
		HttpApiEndpoint.post("apply", "/apply", {
			payload: ChatApplyRequest,
			success: ChatApplyResponse,
			error: [
				ChatToolNotFoundError,
				ChatToolNotApplicableError,
				ChatToolInvalidInputError,
				ChatToolExecutionError,
			],
		}),
	)
	.prefix("/api/chat")
	.middleware(Authorization) {}
