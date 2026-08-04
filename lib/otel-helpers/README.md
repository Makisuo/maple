# @maple/otel-helpers

Tiny helpers around the native `@opentelemetry/api`, intended to be paired with
the [`maple-onboard` skill](../../skills/maple-onboard/SKILL.md). One export:
`withSpan` — wrap a bounded business operation in an active span without
expanding the function body into `tracer.startActiveSpan(...)` plus
`try` / `catch` / `finally`.

## Install

```bash
npm install @maple/otel-helpers @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency.

## Usage

```ts
import { trace } from "@opentelemetry/api"
import { withSpan } from "@maple/otel-helpers"

const tracer = trace.getTracer("orders")

export async function submitOrder(orderId: string, tenantId: string) {
	return withSpan(
		"order.submit",
		async (span) => {
			span.setAttributes({
				"tenant.id": tenantId,
				"order.id": orderId,
			})
			const result = await chargePayment(orderId)
			return result
		},
		{ tracer },
	)
}
```

On throw, `withSpan` calls `span.recordException(err)`, sets
`SpanStatusCode.ERROR` with the error's `message`, ends the span, and rethrows.
On success it ends the span and returns the inner value.

### Use it for bounded business spans

`withSpan` is the right tool when you would otherwise expand a route handler or
job function into:

```ts
return tracer.startActiveSpan("order.submit", async (span) => {
	try {
		// real work
	} catch (err) {
		span.recordException(err as Error)
		span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
		throw err
	} finally {
		span.end()
	}
})
```

### Don't wrap provider SDK calls that OpenInference already observes

If you're calling the OpenAI / Anthropic / etc. SDK and you've installed an
OpenInference instrumentation package, leave the SDK call native. Don't wrap
`client.messages.create(...)` in `withSpan` — the provider instrumentation
already produces a span with model/provider/token attributes.
