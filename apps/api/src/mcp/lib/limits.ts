/**
 * Clamps an agent-supplied `limit` to a safe range.
 *
 * MCP tools expose `limit` params to LLM agents, which have a strong incentive
 * to ask for large page sizes. Apply this helper in every tool handler before
 * passing the value to a Tinybird/ClickHouse query.
 */
export function clampLimit(
  value: number | undefined,
  opts: { defaultValue: number; max: number },
): number {
  const v = value ?? opts.defaultValue
  if (!Number.isFinite(v) || v <= 0) return opts.defaultValue
  return Math.min(Math.floor(v), opts.max)
}

/**
 * Clamps an agent-supplied `offset`. Deep pagination on ClickHouse scans the
 * skipped rows, so an unbounded offset is a foot-gun.
 */
export function clampOffset(
  value: number | undefined,
  opts: { max: number },
): number {
  const v = value ?? 0
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.min(Math.floor(v), opts.max)
}
