# Specifications

This directory contains specifications for all major features and enhancements in the Effect library, following a structured spec-driven development approach that ensures systematic planning, implementation, and validation.

## Contents

- [worker-error-reason-pattern.md](worker-error-reason-pattern.md) - Refactor WorkerError to use the reason pattern with structured reasons.
- [http-client-error-reason-pattern.md](http-client-error-reason-pattern.md) - Refactor HttpClientError to a reason-based wrapper with per-reason classes.
- [http-server-error-reason-pattern.md](http-server-error-reason-pattern.md) - Refactor HttpServerError to use the reason pattern with per-reason classes.
- [effect-ignore-log.md](effect-ignore-log.md) - Add optional logging to `Effect.ignore` and remove `Effect.ignoreLogged`.
- [effect-jsdoc-improvements.md](effect-jsdoc-improvements.md) - Improve JSDoc clarity and consistency for `Effect.ts`.
- [stream-jsdoc-improvements.md](stream-jsdoc-improvements.md) - Improve JSDoc clarity and consistency for `Stream.ts`.
- [scoped-atom-port.md](scoped-atom-port.md) - Port the legacy ScopedAtom module into `@effect/atom-react`.
- [atom-solid-bindings.md](atom-solid-bindings.md) - Add `@effect/atom-solid` bindings for Effect Atom modules in SolidJS.
- [devtools-v3-port.md](devtools-v3-port.md) - Port Effect v3 DevTools modules into `effect/unstable/devtools`.
- [cli-completions-refactor.md](cli-completions-refactor.md) - Replace dynamic CLI completions with static shell script generation for Bash, Zsh, and Fish.
- [ai-openai-compat.md](ai-openai-compat.md) - Add a minimal-schema OpenAI compat package for LanguageModel + embeddings.
- [httpapi-client-middleware.md](httpapi-client-middleware.md) - Add client-side middleware support to HttpApi, mirroring Rpc's `RpcMiddleware.layerClient` pattern.
- [ai-docs-comprehensive.md](ai-docs-comprehensive.md) - Comprehensive AI documentation covering 22 topics: running effects, streams, integration, HTTP servers, RPC, AI modules, cluster, workflows, observability, caching, scheduling, batching, testing, and more.
- [filter-separate-apis.md](filter-separate-apis.md) - Reverse overloaded Filter consolidation: separate predicate/Filter APIs, convert Option-based filterMap to Filter.
- [http-static-files.md](http-static-files.md) - Add static file serving for unstable HTTP (implemented as `HttpStaticServer`, originally specified as `HttpStaticFiles`) with MIME types, conditional requests, range requests, and SPA fallback.
- [revert-option-unboxing.md](revert-option-unboxing.md) - Revert APIs from `A | undefined` back to `Option<A>` across effect, cluster, cli, and platform packages.
- [response-id-tracking.md](response-id-tracking.md) - Add per-client response ID tracking with `prepareUnsafe` method for incremental input mode in OpenAI providers.
- [ai-embedding-model.md](ai-embedding-model.md) - Add `EmbeddingModel` module to `effect/unstable/ai` with batching via `RequestResolver` and telemetry.
- [sql-error-reason-pattern.md](sql-error-reason-pattern.md) - Refactor SqlError to use the reason pattern with per-reason classes and best-effort error classification across all SQL drivers.
