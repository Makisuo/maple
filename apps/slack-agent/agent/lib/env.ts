/**
 * Shared "is this a deployed environment?" predicate.
 *
 * Two independent security gates depend on the same answer — the eve HTTP
 * route auth (agent/channels/eve.ts) and the single-workspace bot-token env
 * fallback (agent/lib/maple.ts) — so it lives in one place rather than being
 * re-derived per call site, where the two could drift apart.
 *
 * Deliberately a function, not a module constant: the value is read at call
 * time so tests can flip the environment, and so a var set after module load
 * still counts.
 */
export function isDeployedEnvironment(): boolean {
  return (
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    process.env.NODE_ENV === "production"
  );
}
