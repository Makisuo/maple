/**
 * The Notifier API contract — the third service in the demo topology.
 *
 * `todo-api` calls this over HTTP whenever a todo changes, which is what turns
 * the service map from a single hop (`todo-web → todo-api`) into a real chain
 * (`todo-web → todo-api → todo-notifier → webhooks`). Because both ends speak
 * Effect's HTTP stack, the outbound call carries the same `traceparent` the
 * browser started, so all three services land in ONE distributed trace.
 */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

/** Which todo lifecycle event triggered the notification. */
export const NotifyEvent = Schema.Literals(["created", "toggled", "removed"])
export type NotifyEvent = typeof NotifyEvent.Type

export class NotifyRequest extends Schema.Class<NotifyRequest>("NotifyRequest")({
	todoId: Schema.String,
	event: NotifyEvent,
	title: Schema.String,
}) {}

export class NotifyReceipt extends Schema.Class<NotifyReceipt>("NotifyReceipt")({
	deliveryId: Schema.String,
	channel: Schema.String,
	/** Whether the rendered template came from the in-process template cache. */
	cached: Schema.Boolean,
}) {}

/**
 * The notifier's own failure mode — a simulated downstream webhook rejection.
 * `todo-api` catches it, so the user-facing request still succeeds while the
 * trace shows an `Error` span deep in the tree. That gap between "HTTP 200" and
 * "something went wrong" is exactly what a trace is for.
 */
export class NotifyDispatchError extends Schema.TaggedError<NotifyDispatchError>()(
	"@maple-examples/todo/NotifyDispatchError",
	{ channel: Schema.String, message: Schema.String },
	{ httpApiStatus: 502 },
) {}

export class NotificationsApiGroup extends HttpApiGroup.make("notifications")
	.add(
		HttpApiEndpoint.post("dispatch", "/", {
			payload: NotifyRequest,
			success: NotifyReceipt,
			error: NotifyDispatchError,
		}),
	)
	.prefix("/api/notifications") {}

export class NotifierApi extends HttpApi.make("NotifierApi").add(NotificationsApiGroup) {}
