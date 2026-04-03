import { effectLoader, effectBeforeLoad } from "./route.ts"

/**
 * Wraps a TanStack Router file route builder with Effect support.
 *
 * - `loader` accepts Effect-returning functions (auto-wrapped with tracing + abort support)
 * - `beforeLoad` accepts Effect-returning functions
 * - `validateSearch` accepts `Schema.toStandardSchemaV1(schema)` (same as before)
 *
 * The returned builder has the same type signature as `createFileRoute(path)`,
 * preserving full type inference for `useSearch()`, `useParams()`, etc.
 *
 * @example
 * ```ts
 * import { createFileRoute } from "@tanstack/react-router"
 * import { effectRoute } from "@effect-router/core"
 * import { Effect, Schema } from "effect"
 *
 * const SearchSchema = Schema.Struct({
 *   tab: Schema.optional(Schema.String),
 * })
 *
 * export const Route = effectRoute(createFileRoute("/chat"))({
 *   validateSearch: Schema.toStandardSchemaV1(SearchSchema),
 *   component: ChatPage,
 *   loader: ({ params }) =>
 *     Effect.gen(function* () {
 *       const svc = yield* MyService
 *       return yield* svc.getData(params)
 *     }),
 * })
 * ```
 */
export function effectRoute<T extends (...args: any[]) => any>(fileRoute: T): T {
  return ((options?: any) => {
    if (!options) return (fileRoute as any)()
    return (fileRoute as any)(transformOptions(options))
  }) as T
}

function transformOptions(
  options: Record<string, any>,
): Record<string, any> {
  const result = { ...options }

  if (typeof options.loader === "function") {
    result.loader = effectLoader(options.loader)
  }

  if (typeof options.beforeLoad === "function") {
    result.beforeLoad = effectBeforeLoad(options.beforeLoad)
  }

  return result
}
