/**
 * Cassette replay for the recorded provider tests.
 *
 * Maple-local replacement for upstream's `@opencode-ai/http-recorder` harness. That harness needed
 * `@effect/platform-node`'s `NodeFileSystem` to read cassettes off disk, which was the last Node-only
 * dependency in this package. Here the cassettes are pulled in through Vite's `import.meta.glob`
 * instead, so the suite has no filesystem dependency and can run under any vitest pool.
 *
 * Two deliberate simplifications versus upstream:
 *
 *   - **Replay only.** There is no `RECORD=true` mode; re-record against upstream and copy the
 *     cassette across. A test whose cassette is missing skips.
 *   - **Interactions are matched in recorded order**, asserting only on the HTTP method. Upstream
 *     matched on the request URL and body, but the stored requests are *redacted* (API keys, account
 *     ids and signatures are stripped from URLs, headers and bodies), so a live request never
 *     compares equal to what is on disk without replaying the redactor as well. Every cassette here
 *     covers exactly one deterministic scenario and has at most two interactions, so positional
 *     matching is equivalent and much less machinery.
 */
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

interface CassetteInteraction {
  readonly transport: string
  readonly request: { readonly method: string; readonly url: string }
  readonly response: {
    readonly status: number
    readonly headers: Record<string, string>
    readonly body: string
    readonly bodyEncoding?: "base64"
  }
}

interface Cassette {
  readonly version: number
  readonly metadata: { readonly name: string }
  readonly interactions: ReadonlyArray<CassetteInteraction>
}

const modules = import.meta.glob<string>("../fixtures/recordings/**/*.json", {
  query: "?raw",
  import: "default",
})

/** Cassette name (e.g. `openai-chat/streams-text`) -> loader. */
const cassettes = new Map(
  Object.entries(modules).map(([path, load]) => {
    const name = path.replace(/^.*\/fixtures\/recordings\//, "").replace(/\.json$/, "")
    return [name, load] as const
  }),
)

export const hasCassette = (name: string) => cassettes.has(name)

const decodeBody = (interaction: CassetteInteraction) =>
  interaction.response.bodyEncoding === "base64"
    ? Uint8Array.from(atob(interaction.response.body), (char) => char.charCodeAt(0))
    : interaction.response.body

/**
 * An `HttpClient` that answers every request from `name`'s cassette, in recorded order.
 * Running out of interactions, or hitting one recorded for a different method, is a defect —
 * the request sequence has diverged from what was recorded and the test result would be a lie.
 */
export const cassetteHttpClient = (name: string) =>
  Effect.gen(function* () {
    const load = cassettes.get(name)
    if (!load) return yield* Effect.die(new Error(`No cassette recorded for "${name}"`))
    const cassette = JSON.parse(yield* Effect.promise(load)) as Cassette
    let cursor = 0

    return HttpClient.make((request) =>
      Effect.suspend(() => {
        const interaction = cassette.interactions[cursor]
        if (!interaction) {
          return Effect.die(
            new Error(
              `Cassette "${name}" has ${cassette.interactions.length} interaction(s) but the test made ` +
                `${cursor + 1}. ${request.method} ${request.url} is unrecorded.`,
            ),
          )
        }
        if (interaction.request.method !== request.method) {
          return Effect.die(
            new Error(
              `Cassette "${name}" interaction ${cursor} was recorded as ` +
                `${interaction.request.method}, but the test issued ${request.method} ${request.url}.`,
            ),
          )
        }
        cursor += 1
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(decodeBody(interaction), {
              status: interaction.response.status,
              headers: { ...interaction.response.headers },
            }),
          ),
        )
      }),
    )
  })

export const cassetteHttpClientLayer = (name: string) =>
  Layer.effect(HttpClient.HttpClient, cassetteHttpClient(name))
