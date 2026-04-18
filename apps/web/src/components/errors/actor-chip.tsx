import type { ActorDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"

export function ActorChip({ actor }: { actor: ActorDocument | null }) {
  if (!actor) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  if (actor.type === "agent") {
    const label = actor.agentName ?? actor.id.slice(0, 8)
    const tooltip = actor.model
      ? `${label} (${actor.model})`
      : label
    return (
      <Badge
        variant="outline"
        className="bg-violet-500/10 text-violet-600 dark:text-violet-300"
        title={tooltip}
      >
        <span aria-hidden className="mr-1">🤖</span>
        {label}
      </Badge>
    )
  }
  const userLabel = actor.userId ?? actor.id.slice(0, 8)
  return (
    <Badge variant="outline" className="bg-muted text-foreground" title={userLabel}>
      <span aria-hidden className="mr-1">👤</span>
      {userLabel}
    </Badge>
  )
}
