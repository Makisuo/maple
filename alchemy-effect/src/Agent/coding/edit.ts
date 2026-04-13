import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import { AspectConfig } from "../Aspect.ts";
import {
  formatDiagnostics,
  getDiagnosticsIfAvailable,
} from "../lsp/diagnostics.ts";
import { Tool } from "../tool/tool.ts";
import { replace } from "../util/replace.ts";

export class filePath extends Tool.input(
  "filePath",
)`The absolute path to the file to modify` {}

export class oldString extends Tool.input(
  "oldString",
)`The text to replace. Use an empty string "" to create a new file.` {}

export class newString extends Tool.input(
  "newString",
)`The text to replace it with (must be different from oldString)` {}

export class replaceAll extends Tool.input(
  "replaceAll",
  S.Boolean,
)`Replace all occurrences of oldString (default false). Use this when renaming variables or updating repeated patterns.` {}

export class output extends Tool.output(
  "result",
)`The result of the edit operation, including any diagnostics from LSP.` {}

export class edit extends Tool(
  "edit",
)`Performs exact string replacements in files.
Returns the ${output} of the operation.

Given a ${filePath}, ${oldString}, and ${newString}:
- Replaces the first occurrence of ${oldString} with ${newString}
- Use ${replaceAll} to replace all occurrences (defaults to false)
- Use empty ${oldString} ("") to create a new file with ${newString} as content
`(function* ({
  filePath: _filePath,
  oldString,
  newString,
  replaceAll: doReplaceAll,
}) {
  const config = yield* Effect.serviceOption(AspectConfig).pipe(
    Effect.map(Option.getOrElse(() => ({ cwd: process.cwd() }))),
  );
  const pathService = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const filePath = pathService.isAbsolute(_filePath)
    ? _filePath
    : pathService.join(config.cwd, _filePath);

  // Determine new content and whether this is a create operation
  let newContent: string;

  if (oldString === "") {
    // Create new file
    newContent = newString;
  } else {
    // Edit existing file - validate it exists
    const stat = yield* fs
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));

    if (!stat) {
      return { result: `File not found: ${filePath}` };
    }
    if (stat.type === "Directory") {
      return { result: `Path is a directory, not a file: ${filePath}` };
    }

    // Read existing content
    const oldContent = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catch((e) => Effect.succeed(`Failed to read file: ${e}`)));
    if (oldContent.startsWith("Failed to read")) {
      return { result: oldContent };
    }

    // Perform replacement
    const replaceResult = yield* replace(
      oldContent,
      oldString,
      newString,
      doReplaceAll ?? false,
    ).pipe(
      Effect.catchTag("ReplaceSameStringError", () =>
        Effect.succeed("oldString and newString must be different"),
      ),
      Effect.catchTag("ReplaceNotFoundError", (e) =>
        Effect.succeed(
          `Could not find oldString in file. The text "${e.oldString.slice(0, 100)}${e.oldString.length > 100 ? "..." : ""}" was not found in ${filePath}.`,
        ),
      ),
      Effect.catchTag("ReplaceMultipleMatchesError", (e) =>
        Effect.succeed(
          `Found multiple matches for oldString "${e.oldString.slice(0, 50)}${e.oldString.length > 50 ? "..." : ""}". Provide more surrounding context to identify the correct match, or use replaceAll=true to replace all occurrences.`,
        ),
      ),
    );

    // Check for replace errors
    if (
      replaceResult.startsWith("Could not find") ||
      replaceResult.startsWith("Found multiple") ||
      replaceResult.startsWith("oldString and newString")
    ) {
      yield* Effect.logDebug(`[edit] ${replaceResult}`);
      return { result: replaceResult };
    }
    newContent = replaceResult;
  }

  const isCreate = oldString === "";

  // Write file
  const writeResult = yield* fs
    .writeFileString(filePath, newContent)
    .pipe(
      Effect.catch((e) =>
        Effect.succeed(
          `Failed to ${isCreate ? "create" : "write"} file: ${e.message}`,
        ),
      ),
    );
  if (typeof writeResult === "string") {
    yield* Effect.logDebug(`[edit] ${writeResult}`);
    return { result: writeResult };
  }

  // Get diagnostics from LSP servers
  const diagnostics = yield* getDiagnosticsIfAvailable(filePath, newContent);
  const formatted = formatDiagnostics(diagnostics);

  yield* Effect.logDebug(
    `[edit] diagnostics for ${filePath}: ${formatted || "(none)"}`,
  );

  const action = isCreate ? "Created" : "Edited";
  return {
    result: formatted
      ? `${action} file: ${filePath}\n\n${formatted}`
      : `${action} file: ${filePath}`,
  };
}) {}
