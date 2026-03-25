---
"effect": patch
"@effect/opentelemetry": patch
---

Refactor call sites with multiple `ServiceMap` mutations to use `ServiceMap.mutate` for batched updates.
