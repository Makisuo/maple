// Copied from alchemy-effect to stay API-compatible for a future migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/Request.ts
//
// Context service exposing the raw platform `Request`. Use this when a handler
// needs CF-specific fields (`cf`, non-standard headers) that the Effect
// `HttpServerRequest` abstracts away.
import * as Context from "effect/Context"

export class Request extends Context.Service<Request, globalThis.Request>()("Request") {}
