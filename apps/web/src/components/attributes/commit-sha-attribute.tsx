import type { ReactNode } from "react"

import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import { formatGenAiCost, formatTokens } from "@maple/ui/lib/gen-ai"

// Resource/span attribute keys whose value is a git commit SHA. Wrapping these
// in the hover card mirrors the trace header (which enriches
// `deployment.commit_sha`) so a commit SHA is hover-resolvable everywhere it
// surfaces in the attribute panels, not just the header. The hover card itself
// guards on a full 40-hex SHA — a short SHA or arbitrary value renders as plain
// (still copyable), so listing a key here is always safe.
const COMMIT_SHA_KEYS = new Set(["deployment.commit_sha", "vcs.ref.head.revision"])

// GenAI (`gen_ai.*`) usage keys carry numbers stringified by the ingest encoder
// ("42"), so the raw attribute table shows bare digits. Format them inline:
// model ids as a chip, token counts with thousands separators, cost as currency.
const GEN_AI_MODEL_KEYS = new Set(["gen_ai.request.model", "gen_ai.response.model"])
const GEN_AI_TOKEN_KEYS = new Set([
	"gen_ai.usage.input_tokens",
	"gen_ai.usage.output_tokens",
	"gen_ai.usage.total_tokens",
	"gen_ai.usage.prompt_tokens",
	"gen_ai.usage.completion_tokens",
])

/**
 * `AttributesConfig.renderValue` implementation. Returns a specialized node for
 * known attribute keys (commit SHAs, GenAI model/token/cost), or `null` to fall
 * back to the default copyable text.
 */
export function renderAttributeValue(attrKey: string, value: string): ReactNode | null {
	if (COMMIT_SHA_KEYS.has(attrKey)) {
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

	if (GEN_AI_MODEL_KEYS.has(attrKey)) {
		return (
			<span className="inline-flex items-center rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
				{value}
			</span>
		)
	}

	if (GEN_AI_TOKEN_KEYS.has(attrKey)) {
		const n = Number(value)
		if (!Number.isFinite(n)) return null
		return <span className="font-mono tabular-nums">{formatTokens(n)}</span>
	}

	if (attrKey === "gen_ai.usage.cost") {
		const n = Number(value)
		if (!Number.isFinite(n)) return null
		return <span className="font-mono tabular-nums">{formatGenAiCost(n)}</span>
	}

	return null
}
