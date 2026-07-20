import { GitCommitSha } from "@maple/domain/http"
import { Schema } from "effect"

/** Decode commit SHA fixtures through the same branded schema used in production. */
export const decodeGitCommitSha = Schema.decodeUnknownSync(GitCommitSha)
