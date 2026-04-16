import type { ModelMessage, LanguageModelUsage } from "ai"
import type {
  SessionSnapshot,
  SessionEntry,
  SessionCompactionEntry,
  CompactionDetails,
  CompactionSettings,
  SessionUsage,
} from "./types"

const encoder = new TextEncoder()

export const defaultCompactionSettings: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_000,
  keepRecentTokens: 32_000,
}

export const createEmptySnapshot = (sessionId: string): SessionSnapshot => ({
  sessionId,
  nextTurnIndex: 1,
  entries: [
    {
      id: `${sessionId}:session`,
      createdAt: Date.now(),
      turnId: "session",
      type: "session",
      sessionId,
    },
  ],
  pendingCommands: [],
  compaction: defaultCompactionSettings,
})

export const estimateMessageTokens = (message: ModelMessage): number =>
  Math.max(32, Math.ceil(encoder.encode(JSON.stringify(message)).length / 4))

export const estimateTextTokens = (text: string): number =>
  Math.max(16, Math.ceil(encoder.encode(text).length / 4))

export const entryEstimatedTokens = (entry: SessionEntry): number => {
  switch (entry.type) {
    case "message":
      return entry.estimatedTokens
    case "custom_message":
      return entry.estimatedTokens
    case "compaction":
      return estimateTextTokens(entry.summary) + estimateTextTokens(entry.turnContextSummary ?? "")
    default:
      return 0
  }
}

const isModelMessageEntry = (
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "message" }> | Extract<SessionEntry, { type: "custom_message" }> =>
  entry.type === "message" || entry.type === "custom_message"

const entryToModelMessages = (entry: SessionEntry): ReadonlyArray<ModelMessage> => {
  if (entry.type === "message") {
    return [entry.message]
  }
  if (entry.type === "custom_message") {
    if (entry.role === "system") {
      return [{ role: "system", content: entry.text }]
    }
    if (entry.role === "user") {
      return [{ role: "user", content: [{ type: "text", text: entry.text }] }]
    }
    return [{ role: "assistant", content: [{ type: "text", text: entry.text }] }]
  }
  return []
}

export const latestCompactionEntry = (
  snapshot: SessionSnapshot,
): SessionCompactionEntry | undefined => {
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index]
    if (entry?.type === "compaction") {
      return entry
    }
  }
  return undefined
}

const resolveFirstVisibleIndex = (snapshot: SessionSnapshot): number => {
  const compaction = latestCompactionEntry(snapshot)
  if (!compaction) return 0

  const firstKeptIndex = snapshot.entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
  return firstKeptIndex === -1 ? 0 : firstKeptIndex
}

export const buildSessionContext = (snapshot: SessionSnapshot): ReadonlyArray<ModelMessage> => {
  const compaction = latestCompactionEntry(snapshot)
  const firstVisibleIndex = resolveFirstVisibleIndex(snapshot)
  const messages: Array<ModelMessage> = []

  if (compaction) {
    messages.push({
      role: "assistant",
      content: [{
        type: "text",
        text: `Conversation summary:\n${compaction.summary}`,
      }],
    })

    if (compaction.turnContextSummary) {
      messages.push({
        role: "assistant",
        content: [{
          type: "text",
          text: `Current turn context:\n${compaction.turnContextSummary}`,
        }],
      })
    }
  }

  for (const entry of snapshot.entries.slice(firstVisibleIndex)) {
    if (!isModelMessageEntry(entry)) continue
    messages.push(...entryToModelMessages(entry))
  }

  return messages
}

export const mergeCompactionDetails = (
  previous: CompactionDetails | undefined,
  next: Partial<CompactionDetails>,
): CompactionDetails => ({
  readFiles: Array.from(new Set([...(previous?.readFiles ?? []), ...(next.readFiles ?? [])])),
  modifiedFiles: Array.from(new Set([...(previous?.modifiedFiles ?? []), ...(next.modifiedFiles ?? [])])),
  toolNames: Array.from(new Set([...(previous?.toolNames ?? []), ...(next.toolNames ?? [])])),
  droppedEntryIds: next.droppedEntryIds ?? previous?.droppedEntryIds ?? [],
  turnContextEntryIds: next.turnContextEntryIds ?? previous?.turnContextEntryIds ?? [],
})

export const toSessionUsage = (
  usage: LanguageModelUsage,
  recordedAtEntryId: string,
): SessionUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  totalTokens: usage.totalTokens,
  recordedAtEntryId,
  recordedAt: Date.now(),
})

export const estimateSnapshotTokens = (snapshot: SessionSnapshot): number => {
  const messages = buildSessionContext(snapshot)
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

export const hasFreshUsageSample = (snapshot: SessionSnapshot): boolean => {
  const usage = snapshot.lastSuccessfulUsage
  if (!usage) return false
  const compaction = latestCompactionEntry(snapshot)
  if (!compaction) return true
  return usage.recordedAt > compaction.createdAt
}
