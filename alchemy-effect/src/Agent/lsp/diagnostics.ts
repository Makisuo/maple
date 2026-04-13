import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { DiagnosticSeverity, type Diagnostic } from "./client.ts";
import { LSPManager } from "./manager.ts";

const MAX_DIAGNOSTICS_PER_FILE = 10;

/**
 * Get diagnostics from LSP if available, otherwise return empty array.
 */
export const getDiagnosticsIfAvailable = (
  filePath: string,
  content: string,
): Effect.Effect<Diagnostic[]> =>
  Effect.serviceOption(LSPManager).pipe(
    Effect.flatMap((maybeManager) => {
      if (Option.isNone(maybeManager)) {
        return Effect.succeed([] as Diagnostic[]);
      }
      const manager = maybeManager.value;
      return manager
        .notifyFileChanged(filePath, content)
        .pipe(Effect.andThen(manager.waitForDiagnostics(filePath)));
    }),
    Effect.catch(() => Effect.succeed([] as Diagnostic[])),
  );

/**
 * Format a single diagnostic for display.
 */
export const formatDiagnostic = (d: Diagnostic): string => {
  const severityMap: Record<number, string> = {
    [DiagnosticSeverity.Error]: "ERROR",
    [DiagnosticSeverity.Warning]: "WARN",
    [DiagnosticSeverity.Information]: "INFO",
    [DiagnosticSeverity.Hint]: "HINT",
  };
  const severity = severityMap[d.severity ?? DiagnosticSeverity.Error];
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  return `${severity} [${line}:${col}] ${d.message}`;
};

/**
 * Format diagnostics for display (matching opencode format).
 * Only shows errors, limits output, and wraps in XML tags.
 */
export const formatDiagnostics = (diagnostics: Diagnostic[]): string => {
  const errors = diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );

  if (errors.length === 0) {
    return "";
  }

  const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE);
  const suffix =
    errors.length > MAX_DIAGNOSTICS_PER_FILE
      ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more`
      : "";

  return `This file has errors, please fix\n<file_diagnostics>\n${limited.map(formatDiagnostic).join("\n")}${suffix}\n</file_diagnostics>`;
};
