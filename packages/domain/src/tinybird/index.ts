/**
 * Tinybird SDK - Exports Only
 *
 * This module exports all endpoint definitions and datasources.
 * Client creation should be done in the consuming application with proper configuration.
 *
 * @example
 * ```ts
 * import { Tinybird } from "@tinybirdco/sdk";
 * import { listTraces, spanHierarchy, listLogs } from "@maple/domain/tinybird";
 *
 * const tinybird = new Tinybird({
 *   baseUrl: process.env.TINYBIRD_HOST,
 *   token: process.env.TINYBIRD_TOKEN,
 *   pipes: { list_traces: listTraces, ... },
 * });
 * ```
 */

// Export all endpoints and their types
export * from "./endpoints"

// Export all datasources and their types
export * from "./datasources"

// Export all materialized views
export * from "./materializations"

// Export shared DB query-shape SQL fragments (label/key derivation)
export * from "./db-query-shape-sql"

// Export shared skip-index expressions (kept in sync with query-engine predicates)
export * from "./index-exprs"

// Export TTL override helpers for BYO Tinybird raw retention
export * from "./ttl-override"
