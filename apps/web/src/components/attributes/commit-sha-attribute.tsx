import type { ReactNode } from "react"

import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"

// Resource/span attribute keys whose value is a git commit SHA. Wrapping these
// in the hover card mirrors the trace header (which enriches
// `deployment.commit_sha`) so a commit SHA is hover-resolvable everywhere it
// surfaces in the attribute panels, not just the header. The hover card itself
// guards on a full 40-hex SHA — a short SHA or arbitrary value renders as plain
// (still copyable), so listing a key here is always safe.
const COMMIT_SHA_KEYS = new Set(["deployment.commit_sha", "vcs.ref.head.revision"])

/**
 * `AttributesConfig.renderValue` implementation. Returns a hover-card-wrapped
 * value for known commit-SHA keys, or `null` to fall back to the default
 * copyable text.
 */
export function renderAttributeValue(attrKey: string, value: string): ReactNode | null {
	if (!COMMIT_SHA_KEYS.has(attrKey)) return null
	return <CommitShaAttributeValue value={value} />
}

export function CommitShaAttributeValue({ value }: { value: string }) {
	return (
		<CommitShaHoverCard
			sha={value}
			copy={{ value, label: "commit SHA" }}
			className="-mx-0.5 cursor-pointer break-all rounded px-0.5 transition-colors hover:bg-muted/50"
		>
			{value}
		</CommitShaHoverCard>
	)
}
