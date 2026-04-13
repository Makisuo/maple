import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { AspectConfig } from "../Aspect.ts";
import {
  formatDiagnostics,
  getDiagnosticsIfAvailable,
} from "../lsp/diagnostics.ts";
import { Tool } from "../tool/tool.ts";

class filePath extends Tool.input(
  "filePath",
)`The path to the file to write. Use relative paths from the current working directory (e.g., "src/index.ts", "test/fixtures/math.test.ts"). Do NOT use paths starting with "/" - use relative paths instead.` {}

class content extends Tool.input(
  "content",
)`The content to write to the file.` {}

class output extends Tool.output(
  "result",
)`The result of the write operation, including any diagnostics from LSP.` {}

export class write extends Tool("write")`Writes a file to the local filesystem.
Returns the ${output} of the operation.

Given a ${filePath} and ${content}:
- Use relative paths from the current working directory (e.g., "src/index.ts", "test/fixtures/math.test.ts")
- Do NOT use paths starting with "/" - use relative paths instead
- This tool will overwrite the existing file if there is one at the provided path.
- Parent directories are created automatically if they don't exist.
`(function* ({ filePath: _filePath, content }) {
  yield* Effect.logDebug(
    `[write] filePath=${_filePath} content.length=${content.length}`,
  );

  const config = yield* Effect.serviceOption(AspectConfig).pipe(
    Effect.map(Option.getOrElse(() => ({ cwd: process.cwd() }))),
  );
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const filePath = path.isAbsolute(_filePath)
    ? _filePath
    : path.join(config.cwd, _filePath);

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.catch(() => Effect.void));

  const writeResult = yield* fs
    .writeFileString(filePath, content)
    .pipe(
      Effect.catch((e) =>
        Effect.succeed(`Failed to write file ${filePath}: ${e}`),
      ),
    );

  if (typeof writeResult === "string") {
    yield* Effect.logDebug(`[write] ${writeResult}`);
    return { result: writeResult };
  }

  // Get diagnostics from LSP servers
  const diagnostics = yield* getDiagnosticsIfAvailable(filePath, content);
  const formatted = formatDiagnostics(diagnostics);

  yield* Effect.logDebug(
    `[write] diagnostics for ${filePath}: ${formatted || "(none)"}`,
  );

  return {
    result: formatted
      ? `Wrote file: ${filePath}\n\n${formatted}`
      : `Wrote file: ${filePath}`,
  };
}) {}
