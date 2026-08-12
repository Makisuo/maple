/**
 * The notification dispatcher — the deepest layer of the demo's trace tree.
 *
 * Everything here exists to make a waterfall worth looking at:
 *
 * - a read-through **template cache** (`cache.get` / `cache.set` spans carrying
 *   `cache.hit`), cold on the first notification of each event type,
 * - a **simulated outbound webhook** modelled as a CLIENT span with HTTP client
 *   semconv attributes, so Maple's service map draws an external `webhooks`
 *   dependency node,
 * - a **slow tail**: ~8% of dispatches take 800–1500ms, so `maple slow-traces`
 *   has genuine outliers instead of a flat latency distribution,
 * - a **second error class**: ~10% fail with `NotifyDispatchError`, recorded as
 *   a span event *and* an error log *and* an Error span status.
 *
 * No real network call is made — `hooks.example.internal` does not exist. The
 * span is a faithful description of a webhook POST that is simulated with a
 * sleep, which is what keeps the example runnable offline.
 */
import { Clock, Context, Duration, Effect, Layer, Random, Ref } from "effect"
import { type NotifyEvent, NotifyDispatchError, NotifyReceipt } from "../shared/notifier-api.ts"

/** The channel every notification is (pretend-)delivered to. */
const CHANNEL = "webhooks"
const WEBHOOK_HOST = "hooks.example.internal"
const WEBHOOK_URL = `https://${WEBHOOK_HOST}/v1/notify`

/** Sleep a random number of ms in [min, max] so spans are visibly wide. */
const jitter = (minMs: number, maxMs: number) =>
	Random.nextBetween(minMs, maxMs).pipe(
		Effect.flatMap((delayMs) => Effect.sleep(Duration.millis(Math.floor(delayMs)))),
	)

/**
 * Attach an OTel span event to the *current* span. `Tracer.Span.event` wants an
 * explicit start time in nanos, which `Clock.currentTimeNanos` supplies.
 * Outside a span this is a no-op rather than a failure.
 */
const spanEvent = (name: string, attributes?: Record<string, unknown>) =>
	Effect.currentSpan.pipe(
		Effect.flatMap((span) =>
			Clock.currentTimeNanos.pipe(Effect.map((nanos) => span.event(name, nanos, attributes))),
		),
		Effect.ignore,
	)

const templateFor = (event: NotifyEvent): string => {
	switch (event) {
		case "created":
			return "✅ “{{title}}” was added"
		case "toggled":
			return "🔁 “{{title}}” changed state"
		case "removed":
			return "🗑️ “{{title}}” was deleted"
	}
}

export class NotificationService extends Context.Service<NotificationService>()(
	"@maple-examples/todo/NotificationService",
	{
		make: Effect.gen(function* () {
			const templates = yield* Ref.make(new Map<string, string>())

			/**
			 * Read-through template cache. The first notification of each event type
			 * misses and pays the render cost; later ones hit. Both outcomes are
			 * visible as `cache.hit` on the `cache.get` span.
			 */
			const renderTemplate = Effect.fn("template.resolve")(function* (event: NotifyEvent) {
				const key = `template:${event}`

				const cached = yield* Effect.gen(function* () {
					yield* jitter(1, 4)
					const map = yield* Ref.get(templates)
					const hit = map.get(key)
					yield* Effect.annotateCurrentSpan("cache.hit", hit !== undefined)
					return hit
				}).pipe(
					Effect.withSpan("cache.get", {
						kind: "client",
						attributes: {
							"cache.system": "memory",
							"cache.operation": "get",
							"cache.key": key,
						},
					}),
				)

				if (cached !== undefined) {
					yield* Effect.annotateCurrentSpan("cache.hit", true)
					return cached
				}

				const rendered = yield* Effect.gen(function* () {
					// Compiling a template is the expensive part a cache exists to avoid.
					yield* jitter(25, 70)
					return templateFor(event)
				}).pipe(Effect.withSpan("template.compile", { attributes: { "template.event": event } }))

				yield* Ref.update(templates, (map) => new Map(map).set(key, rendered)).pipe(
					Effect.withSpan("cache.set", {
						kind: "client",
						attributes: {
							"cache.system": "memory",
							"cache.operation": "set",
							"cache.key": key,
						},
					}),
				)
				yield* Effect.annotateCurrentSpan("cache.hit", false)
				return rendered
			})

			const dispatch = Effect.fn("NotificationService.dispatch")(function* (input: {
				readonly todoId: string
				readonly event: NotifyEvent
				readonly title: string
			}) {
				yield* Effect.annotateCurrentSpan({
					"notification.event": input.event,
					"notification.channel": CHANNEL,
					"todo.id": input.todoId,
				})

				const before = yield* Ref.get(templates)
				const template = yield* renderTemplate(input.event)
				const cacheHit = before.has(`template:${input.event}`)
				const body = template.replace("{{title}}", input.title)

				// The simulated webhook POST. `peer.service` + `server.address` are
				// what draw the external dependency node on Maple's service map.
				const deliveryId = yield* Effect.gen(function* () {
					// The slow tail: one dispatch in ~12 is a latency outlier.
					const slow = (yield* Random.next) < 0.08
					if (slow) {
						yield* Effect.annotateCurrentSpan("maple.example.slow_path", true)
						yield* spanEvent("webhook.retry_backoff", { "retry.attempt": 2 })
						yield* jitter(800, 1500)
					} else {
						yield* jitter(30, 120)
					}

					if ((yield* Random.next) < 0.1) {
						yield* Effect.annotateCurrentSpan("http.response.status_code", 502)
						yield* spanEvent("webhook.retry_exhausted", {
							"retry.attempts": 3,
							"error.type": "NotifyDispatchError",
						})
						return yield* new NotifyDispatchError({
							channel: CHANNEL,
							message: `Webhook endpoint ${WEBHOOK_HOST} rejected delivery for ${input.todoId}`,
						})
					}

					yield* Effect.annotateCurrentSpan({
						"http.response.status_code": 202,
						"notification.body_length": body.length,
					})
					return crypto.randomUUID()
				}).pipe(
					Effect.withSpan("POST /v1/notify", {
						kind: "client",
						attributes: {
							"http.request.method": "POST",
							"server.address": WEBHOOK_HOST,
							"server.port": 443,
							"url.full": WEBHOOK_URL,
							"peer.service": CHANNEL,
						},
					}),
					Effect.tapError((error) =>
						Effect.logError("notification.dispatch.failed").pipe(
							Effect.annotateLogs({
								"todo.id": input.todoId,
								"notification.event": input.event,
								"error.type": error._tag,
							}),
						),
					),
				)

				yield* Effect.logInfo("notification.dispatched").pipe(
					Effect.annotateLogs({
						"todo.id": input.todoId,
						"notification.event": input.event,
						"notification.channel": CHANNEL,
						"cache.hit": cacheHit,
					}),
				)

				return new NotifyReceipt({ deliveryId, channel: CHANNEL, cached: cacheHit })
			})

			return { dispatch } as const
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
