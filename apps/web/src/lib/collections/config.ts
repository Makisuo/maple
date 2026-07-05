/**
 * Build-time switch for the ElectricSQL sync path. Defaults OFF: the app keeps
 * using its existing effect-atom fetches until Electric infra (Electric Cloud +
 * the shape proxy's ELECTRIC_URL) is provisioned and the vertical is verified,
 * at which point set VITE_ELECTRIC_SYNC=1 to flip consumers onto live sync.
 *
 * A build-time constant (not runtime) so a component can branch on it at the top
 * of a hook without violating the rules of hooks — the value is fixed per build.
 */
export const ELECTRIC_SYNC_ENABLED = import.meta.env.VITE_ELECTRIC_SYNC === "1"
