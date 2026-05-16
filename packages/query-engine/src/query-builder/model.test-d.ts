// ---------------------------------------------------------------------------
// Type-level drift guard: the runtime query-draft union must stay assignable to
// the domain wire schema, so a draft built in memory is always a valid payload.
// ---------------------------------------------------------------------------

import { expectTypeOf } from "expect-type"
import type { QueryBuilderQueryDraftPayload } from "@maple/domain/http"
import type { QueryBuilderQueryDraft } from "./model"

expectTypeOf<QueryBuilderQueryDraft>().toExtend<QueryBuilderQueryDraftPayload>()
