// ---------------------------------------------------------------------------
// Test Utilities for CH Query Engine
//
// Inspired by Kysely's testSql() pattern: compile queries to SQL strings and
// provide both fragment-based and exact-match assertion helpers.
// ---------------------------------------------------------------------------

import { expect } from "bun:test"
import { compileCH, compileUnion, type CompiledQuery } from "./compile"
import type { CHQuery } from "./query"
import type { CHUnionQuery } from "./union"

/**
 * Normalize SQL whitespace for stable exact-match comparison.
 * Collapses all runs of whitespace (spaces, newlines, tabs) into single spaces.
 */
function normalizeSQL(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

/**
 * Compile a CHQuery and return assertion helpers.
 *
 * Usage:
 *   const t = testSQL(myQuery, params)
 *   t.toContainSQL("FROM traces")           // fragment check
 *   t.toMatchSQL("SELECT ... FROM traces")  // exact normalized match
 *   t.sql                                    // raw SQL for ad-hoc checks
 */
export function testSQL<O extends Record<string, any>>(
  query: CHQuery<any, O>,
  params: Record<string, any>,
  options?: { skipFormat?: boolean },
) {
  const compiled = compileCH(query, params, options)
  const normalized = normalizeSQL(compiled.sql)

  return {
    sql: compiled.sql,
    normalizedSQL: normalized,
    toContainSQL(fragment: string) {
      expect(compiled.sql).toContain(fragment)
    },
    toMatchSQL(expected: string) {
      expect(normalized).toBe(normalizeSQL(expected))
    },
    toNotContainSQL(fragment: string) {
      expect(compiled.sql).not.toContain(fragment)
    },
  }
}

/**
 * Same as testSQL but for UNION ALL queries.
 */
export function testUnionSQL<O extends Record<string, any>>(
  query: CHUnionQuery<O>,
  params: Record<string, any>,
) {
  const compiled = compileUnion(query, params)
  const normalized = normalizeSQL(compiled.sql)

  return {
    sql: compiled.sql,
    normalizedSQL: normalized,
    toContainSQL(fragment: string) {
      expect(compiled.sql).toContain(fragment)
    },
    toMatchSQL(expected: string) {
      expect(normalized).toBe(normalizeSQL(expected))
    },
    toNotContainSQL(fragment: string) {
      expect(compiled.sql).not.toContain(fragment)
    },
    unionCount() {
      return (compiled.sql.match(/UNION ALL/g) || []).length
    },
  }
}
