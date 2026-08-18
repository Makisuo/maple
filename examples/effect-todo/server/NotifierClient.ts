/**
 * `todo-api`'s typed client for the `todo-notifier` service, derived from the
 * shared `NotifierApi` contract — the same trick the browser uses for the todo
 * API (`web/src/lib/atom-client.ts`), one hop further down.
 *
 * Two details make the demo work:
 *
 * - Effect's `HttpClient` wraps each call in a CLIENT span and injects
 *   `traceparent`, so `todo-notifier`'s server span continues the trace that
 *   started in the browser. That single trace crossing three services is the
 *   whole point of the example.
 * - `peer.service` on the outbound span is what draws the
 *   `todo-api → todo-notifier` edge on Maple's service map.
 */
import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { NotifierApi } from "../shared/notifier-api.ts"

export const notifierBaseUrl = process.env.NOTIFIER_URL ?? "http://127.0.0.1:4502"

export class NotifierClient extends Context.Service<NotifierClient>()("@maple-examples/todo/NotifierClient", {
	make: Effect.gen(function* () {
		const client = yield* HttpApiClient.make(NotifierApi, {
			baseUrl: notifierBaseUrl,
			transformClient: (httpClient) =>
				HttpClient.transform(httpClient, (effect) =>
					Effect.annotateSpans(effect, "peer.service", "todo-notifier"),
				),
		})
		return client.notifications
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
