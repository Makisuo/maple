import { formatStars } from "../lib/github-stars"

const REPO_URL = "https://github.com/MapleTechLabs/maple"

/** GitHub "octocat" mark. Inherits color via `currentColor`. */
export function Octocat({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
		</svg>
	)
}

/**
 * GitHub link rendered as a star-count button: octocat on the left, a divider,
 * then the golden star + count — so the two marks each get their own cell
 * instead of crowding each other.
 *
 * When the count is unavailable (build-time fetch failed) it falls back to a
 * plain octocat link. `className` MUST carry a flex display (e.g.
 * `inline-flex` / `hidden sm:inline-flex`) so the cells lay out.
 */
export function GithubStarButton({ stars, className }: { stars?: number | null; className?: string }) {
	if (stars == null) {
		return (
			<a
				href={REPO_URL}
				target="_blank"
				rel="noopener noreferrer"
				aria-label="GitHub"
				className={`items-center text-fg-muted transition-colors hover:text-fg ${className ?? ""}`}
			>
				<Octocat className="w-4 h-4" />
			</a>
		)
	}

	return (
		<a
			href={REPO_URL}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={`Star Maple on GitHub — ${formatStars(stars)} stars`}
			className={`items-stretch h-7 overflow-hidden rounded-lg border border-border text-fg-muted transition-colors hover:border-fg-muted/40 hover:text-fg ${className ?? ""}`}
		>
			<span className="flex items-center px-2.5">
				<Octocat className="w-4 h-4" />
			</span>
			<span className="flex items-center border-l border-border px-2.5 text-xs font-medium tabular-nums">
				{formatStars(stars)}
			</span>
		</a>
	)
}
