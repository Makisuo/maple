/**
 * Declarative warehouse query registry.
 *
 * Kept out of the root barrel deliberately: entries pull in `./runtime` for the
 * cache-policy types, and the root barrel stays driver-free so web and cli can
 * import it. Only `apps/api` should reach for this subpath.
 */
export { defineQuery, type QueryDef } from "./query-def"
export * as Queries from "./queries"
