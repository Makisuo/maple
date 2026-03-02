import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export class AgentEnv extends Effect.Service<AgentEnv>()("AgentEnv", {
  accessors: true,
  effect: Effect.gen(function* () {
    const env = {
      // Maple API
      MAPLE_API_URL: yield* Config.string("MAPLE_API_URL"),
      INTERNAL_SERVICE_TOKEN: yield* Config.string("INTERNAL_SERVICE_TOKEN"),

      // Database (shared with API)
      MAPLE_DB_URL: yield* Config.string("MAPLE_DB_URL").pipe(Config.withDefault("")),
      MAPLE_DB_AUTH_TOKEN: yield* Config.string("MAPLE_DB_AUTH_TOKEN").pipe(Config.withDefault("")),

      // GitHub App
      GITHUB_APP_ID: yield* Config.string("GITHUB_APP_ID"),
      GITHUB_APP_PRIVATE_KEY: yield* Config.string("GITHUB_APP_PRIVATE_KEY"),

      // Agent tuning
      AGENT_INTERVAL_SECONDS: yield* Config.number("AGENT_INTERVAL_SECONDS").pipe(Config.withDefault(300)),
      AGENT_DETECTION_WINDOW_MINUTES: yield* Config.number("AGENT_DETECTION_WINDOW_MINUTES").pipe(Config.withDefault(15)),
      AGENT_ERROR_RATE_SPIKE_MULTIPLIER: yield* Config.number("AGENT_ERROR_RATE_SPIKE_MULTIPLIER").pipe(Config.withDefault(2.0)),
      AGENT_ERROR_RATE_ABSOLUTE_THRESHOLD: yield* Config.number("AGENT_ERROR_RATE_ABSOLUTE_THRESHOLD").pipe(Config.withDefault(5)),
      AGENT_LATENCY_SPIKE_MULTIPLIER: yield* Config.number("AGENT_LATENCY_SPIKE_MULTIPLIER").pipe(Config.withDefault(1.5)),
      AGENT_APDEX_THRESHOLD: yield* Config.number("AGENT_APDEX_THRESHOLD").pipe(Config.withDefault(0.7)),
      AGENT_COOLDOWN_HOURS: yield* Config.number("AGENT_COOLDOWN_HOURS").pipe(Config.withDefault(4)),
    } as const

    return env
  }),
}) {}
