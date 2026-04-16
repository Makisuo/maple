import { Effect } from "effect"
import { AgentHarnessCompactionError } from "./errors"
import {
  buildSessionContext,
  entryEstimatedTokens,
  estimateSnapshotTokens,
  hasFreshUsageSample,
  latestCompactionEntry,
  mergeCompactionDetails,
} from "./session-context"
import type {
  AgentModelGatewayShape,
  CompactionPreparation,
  CompactionResult,
  SessionCompactionEntry,
  SessionEntry,
  SessionSnapshot,
} from "./types"

const isToolResultMessage = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "tool"

const extractToolDetails = (entries: ReadonlyArray<SessionEntry>) => {
  const toolNames = new Set<string>()
  const readFiles = new Set<string>()
  const modifiedFiles = new Set<string>()

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "tool") continue
    const content = Array.isArray(entry.message.content) ? entry.message.content : []
    for (const part of content) {
      if (!part || typeof part !== "object" || !("type" in part)) continue
      if ((part as { type: string }).type === "tool-result") {
        const partAny = part as Record<string, unknown>
        if (typeof partAny.toolName === "string") toolNames.add(partAny.toolName)
        const result = partAny.output
        if (result && typeof result === "object") {
          const read = (result as Record<string, unknown>).readFiles
          const modified = (result as Record<string, unknown>).modifiedFiles
          if (Array.isArray(read)) for (const file of read) if (typeof file === "string") readFiles.add(file)
          if (Array.isArray(modified)) for (const file of modified) if (typeof file === "string") modifiedFiles.add(file)
        }
      }
    }
  }

  return {
    toolNames: Array.from(toolNames),
    readFiles: Array.from(readFiles),
    modifiedFiles: Array.from(modifiedFiles),
  }
}

const computeCutIndex = (snapshot: SessionSnapshot, keepRecentTokens: number): number => {
  let keptTokens = 0
  let cutIndex = snapshot.entries.length

  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index]
    if (!entry) continue
    keptTokens += entryEstimatedTokens(entry)
    if (keptTokens > keepRecentTokens) {
      cutIndex = Math.min(index + 1, snapshot.entries.length - 1)
      break
    }
  }

  if (cutIndex >= snapshot.entries.length) return snapshot.entries.length
  while (cutIndex < snapshot.entries.length && isToolResultMessage(snapshot.entries[cutIndex]!)) {
    cutIndex += 1
  }
  return Math.min(cutIndex, snapshot.entries.length)
}

export const prepareCompaction = (
  snapshot: SessionSnapshot,
  contextWindow: number,
): CompactionPreparation | undefined => {
  if (!snapshot.compaction.enabled) return undefined

  const cutIndex = computeCutIndex(snapshot, snapshot.compaction.keepRecentTokens)
  if (cutIndex <= 1 || cutIndex >= snapshot.entries.length) return undefined

  const firstKeptEntry = snapshot.entries[cutIndex]
  if (!firstKeptEntry) return undefined

  const droppedEntries = snapshot.entries.slice(0, cutIndex)
  const keptEntries = snapshot.entries.slice(cutIndex)

  if (droppedEntries.length === 0) return undefined

  const splitTurnId = firstKeptEntry.turnId
  const splitIndex = droppedEntries.findIndex((entry) => entry.turnId === splitTurnId)
  const hasSplitTurn = splitIndex !== -1
  const historyEntries = hasSplitTurn ? droppedEntries.slice(0, splitIndex) : droppedEntries
  const turnContextEntries = hasSplitTurn ? droppedEntries.slice(splitIndex) : []
  const previousCompaction = latestCompactionEntry(snapshot)
  const details = {
    ...extractToolDetails(droppedEntries),
    droppedEntryIds: droppedEntries.map((entry) => entry.id),
    turnContextEntryIds: turnContextEntries.map((entry) => entry.id),
  }

  const estimatedTokens = hasFreshUsageSample(snapshot) && snapshot.lastSuccessfulUsage?.inputTokens
    ? snapshot.lastSuccessfulUsage.inputTokens + snapshot.compaction.reserveTokens
    : estimateSnapshotTokens(snapshot)

  if (estimatedTokens + snapshot.compaction.reserveTokens < contextWindow) {
    return undefined
  }

  return {
    tokensBefore: estimatedTokens,
    firstKeptEntryId: firstKeptEntry.id,
    keptEntries,
    droppedEntries,
    historyEntries,
    turnContextEntries,
    previousCompaction,
    details,
  }
}

export const applyCompaction = (
  snapshot: SessionSnapshot,
  turnId: string,
  preparation: CompactionPreparation,
  summary: {
    readonly summary: string
    readonly turnContextSummary?: string
    readonly details?: Partial<CompactionPreparation["details"]>
  },
): CompactionResult => {
  const previousDetails = preparation.previousCompaction?.details
  const entry: SessionCompactionEntry = {
    id: `${snapshot.sessionId}:compaction:${Date.now()}`,
    createdAt: Date.now(),
    turnId,
    type: "compaction",
    summary: summary.summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    turnContextSummary: summary.turnContextSummary,
    details: mergeCompactionDetails(previousDetails, {
      ...preparation.details,
      ...summary.details,
    }),
  }

  return {
    entry,
    preparation,
    snapshot: {
      ...snapshot,
      entries: [...snapshot.entries, entry],
    },
  }
}

export const compactSnapshot = (
  snapshot: SessionSnapshot,
  turnId: string,
  modelGateway: AgentModelGatewayShape,
  abortSignal?: AbortSignal,
) =>
  Effect.gen(function* () {
    const preparation = prepareCompaction(snapshot, modelGateway.contextWindow)
    if (!preparation) return undefined

    const summary = yield* modelGateway.summarizeCompaction({
      snapshot,
      preparation,
      abortSignal,
    }).pipe(
      Effect.mapError((error) =>
        new AgentHarnessCompactionError({
          message: error.message,
        }),
      ),
    )

    return applyCompaction(snapshot, turnId, preparation, summary)
  })

export const renderCompactionPrompt = (
  snapshot: SessionSnapshot,
  preparation: CompactionPreparation,
): string => {
  const previousSummary = preparation.previousCompaction?.summary
  const history = buildSessionContext({
    ...snapshot,
    entries: preparation.historyEntries,
  })
  const turnContext = buildSessionContext({
    ...snapshot,
    entries: preparation.turnContextEntries,
  })

  return [
    "Summarize the conversation state for future continuation.",
    "Preserve decisions, constraints, unresolved questions, and operational context.",
    "Be explicit about file names, dashboards, services, or tools when they matter.",
    previousSummary ? `Previous summary:\n${previousSummary}` : "",
    history.length > 0 ? `History to compress:\n${JSON.stringify(history, null, 2)}` : "",
    turnContext.length > 0 ? `Dropped prefix of the current turn:\n${JSON.stringify(turnContext, null, 2)}` : "",
  ].filter(Boolean).join("\n\n")
}
