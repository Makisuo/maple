import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import { AspectConfig } from "../Aspect.ts";
import { Tool } from "../tool/tool.ts";

class filePath extends Tool.input(
  "filePath",
)`The path to the file to read. Use relative paths from the current working directory (e.g., "src/index.ts", "test/fixtures/math.ts"). Do NOT use paths starting with "/" - use relative paths instead.` {}

class offset extends Tool.input(
  "offset",
  S.optional(S.Number),
)`The line number to start reading from (0-based). Defaults to 0.` {}

class limit extends Tool.input(
  "limit",
  S.optional(S.Number),
)`The number of lines to read. Defaults to 2000.` {}

class content extends Tool.output(
  "content",
)`The file content, or an error message if the file cannot be read.` {}

export class read extends Tool("read")`Reads a file from the local filesystem.
Returns the ${content} of the file.

Given a ${filePath} and optional ${offset} and ${limit}:
- Use relative paths from the current working directory (e.g., "src/index.ts", "test/fixtures/math.ts")
- Do NOT use paths starting with "/" - use relative paths instead
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit for long files
`(function* ({ filePath: _filePath, offset: _offset, limit: _limit }) {
  yield* Effect.logDebug(`[read] filePath=${_filePath}`);

  const config = yield* Effect.serviceOption(AspectConfig).pipe(
    Effect.map(Option.getOrElse(() => ({ cwd: process.cwd() }))),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const offset = _offset ?? 0;
  const limit = _limit ?? 2000;

  if (_filePath.includes(".env")) {
    return {
      content: "Environment files (.env) are not readable for security reasons",
    };
  }

  const filePath = path.isAbsolute(_filePath)
    ? _filePath
    : path.join(config.cwd, _filePath);

  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.catch(() => Effect.succeed(false)));

  if (!exists) {
    // Try to get suggestions from parent directory
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const dirExists = yield* fs
      .exists(dir)
      .pipe(Effect.catch(() => Effect.succeed(false)));

    if (dirExists) {
      const files = yield* fs
        .readDirectory(dir)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])));
      const suggestions = files
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) ||
            base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3);

      if (suggestions.length > 0) {
        return {
          content: `File not found: ${filePath}. Did you mean one of these?\n${suggestions.join("\n")}`,
        };
      }
    }
    return { content: `File not found: ${filePath}` };
  }

  // Check if it's a directory
  const stat = yield* fs
    .stat(filePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));

  if (stat?.type === "Directory") {
    const entries = yield* fs
      .readDirectory(filePath)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    return {
      content: `Cannot read directory as a file: ${filePath}\nThis is a directory. Contents:\n${entries.slice(0, 10).join("\n")}${entries.length > 10 ? "\n..." : ""}`,
    };
  }

  const fileContent = yield* fs
    .readFileString(filePath)
    .pipe(
      Effect.catch((e) =>
        Effect.succeed(`Failed to read file ${filePath}: ${e}`),
      ),
    );

  return {
    content: fileContent
      .split("\n")
      .slice(offset, offset + limit)
      .join("\n"),
  };
}) {}
