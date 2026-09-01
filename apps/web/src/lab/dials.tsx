/**
 * DialKit's control panel, mounted per lab rather than in the app root.
 *
 * The `src/routes/lab/*` shells are static — file-based routing has no
 * per-environment tree — so a `DialRoot` in the layout route would put dialkit
 * and its stylesheet in the startup bundle, which `perf/check-bundle-budget.ts`
 * forbids. Mounting from `src/lab/` keeps both in the lab's split chunk.
 *
 * The panels themselves come from `useDialKit` in whichever lab renders this;
 * the store is a module singleton, so mount order does not matter.
 */
import { DialRoot, type DialPosition, type DialTheme } from "dialkit"
import "dialkit/styles.css"

export function LabDials({
	position = "bottom-right",
	theme = "system",
}: {
	position?: DialPosition
	theme?: DialTheme
}) {
	// `DialRoot` already no-ops without `productionEnabled`; this makes the
	// dev-only intent local rather than a prop we could forget to leave unset.
	if (!import.meta.env.DEV) return null
	return <DialRoot position={position} theme={theme} />
}
