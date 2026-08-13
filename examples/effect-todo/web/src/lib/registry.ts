/**
 * Wires the effect-atom registry. Mirrors apps/web/src/lib/registry.ts.
 *
 * The OTel layer is added as a GLOBAL layer so the Tracer lives in the same
 * runtime as the atom client's HTTP calls — that's what causes each request's
 * span to be created, exported, and `traceparent`-propagated to the backend.
 * FetchHttpClient is primed first so the OTLP exporter reuses the same build.
 */
import { FetchHttpClient } from "effect/unstable/http"
import { appStartedAtom } from "./actions.ts"
import { TodoApiClient } from "./atom-client.ts"
import { Atom, AtomRegistry, scheduleTask } from "./effect-atom.ts"
import { todoOtelLayer } from "./otel.ts"

Atom.runtime.addGlobalLayer(FetchHttpClient.layer)
Atom.runtime.addGlobalLayer(todoOtelLayer)

export const appRegistry = AtomRegistry.make({ scheduleTask })
appRegistry.mount(TodoApiClient.runtime)

// One root span + log line at startup, so `todo-web` reports telemetry that
// isn't request-shaped. Fired here rather than from a React effect so it runs
// exactly once, outside StrictMode's double-mount.
appRegistry.set(appStartedAtom, undefined)
