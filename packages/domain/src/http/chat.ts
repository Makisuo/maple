import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

/**
 * Apply an approval-gated AI chat proposal. The chat backend uses
 * propose-then-apply: a mutating tool returns a `{ status: "proposed", tool,
 * input }` marker instead of mutating, and the web client applies the real
 * change here on approve. This endpoint re-runs the named MCP mutation tool
 * under the caller's Clerk-authenticated org — reusing the exact tool
 * implementation, so there's a single source of truth for each mutation.
 */
export class ChatApplyRequest extends Schema.Class<ChatApplyRequest>("ChatApplyRequest")({
	/** MCP tool base name, e.g. `update_dashboard_widget`. */
	tool: Schema.String,
	/** The proposed tool input (validated against the tool's own schema server-side). */
	input: Schema.Unknown,
}) {}

export class ChatApplyResponse extends Schema.Class<ChatApplyResponse>("ChatApplyResponse")({
	/** Human-readable result text from the tool (joined content). */
	content: Schema.String,
	/** True when the tool ran but reported a domain-level error (e.g. validation). */
	isError: Schema.optionalKey(Schema.Boolean),
}) {}

export class ChatToolNotFoundError extends Schema.TaggedErrorClass<ChatToolNotFoundError>()(
	"@maple/http/errors/ChatToolNotFoundError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class ChatToolNotApplicableError extends Schema.TaggedErrorClass<ChatToolNotApplicableError>()(
	"@maple/http/errors/ChatToolNotApplicableError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ChatToolInvalidInputError extends Schema.TaggedErrorClass<ChatToolInvalidInputError>()(
	"@maple/http/errors/ChatToolInvalidInputError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ChatApiGroup extends HttpApiGroup.make("chat")
	.add(
		HttpApiEndpoint.post("apply", "/apply", {
			payload: ChatApplyRequest,
			success: ChatApplyResponse,
			error: [ChatToolNotFoundError, ChatToolNotApplicableError, ChatToolInvalidInputError],
		}),
	)
	.prefix("/api/chat")
	.middleware(Authorization) {}
