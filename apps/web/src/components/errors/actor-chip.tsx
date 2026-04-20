import type { ActorDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

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

function actorInitial(actor: ActorDocument): string {
  if (actor.type === "agent") {
    const source = actor.agentName ?? actor.model ?? actor.id
    return source.charAt(0).toUpperCase()
  }
  const source = actor.userId ?? actor.id
  return source.charAt(0).toUpperCase()
}

function actorLabel(actor: ActorDocument): string {
  if (actor.type === "agent") {
    return actor.agentName ?? actor.id.slice(0, 8)
  }
  return actor.userId ?? actor.id.slice(0, 8)
}

export function ActorAvatar({
  actor,
  className,
}: {
  actor: ActorDocument | null
  className?: string
}) {
  if (!actor) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border text-[10px] text-muted-foreground",
          className,
        )}
      >
        ·
      </span>
    )
  }

  const label = actorLabel(actor)
  const isAgent = actor.type === "agent"

  return (
    <span
      title={label}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-full text-[10px] font-medium select-none",
        isAgent
          ? "bg-violet-500/15 text-violet-600 dark:text-violet-300"
          : "bg-muted text-foreground",
        className,
      )}
    >
      {actorInitial(actor)}
    </span>
  )
}
